import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Module setup ──────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  remote: string;
  url: string;
  /** "" = repo root; otherwise the synced subdirectory. */
  dir: string;
}

export interface SyncPair {
  /** Baked into shadow branch names — renaming breaks dedup. */
  name: string;
  /** Symmetric: direction is chosen at runtime via --from. */
  a: RepoEndpoint;
  b: RepoEndpoint;
}

interface ShadowSyncConfig {
  pairs: SyncPair[];
  trailers: { replayed: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  shadowBranchPrefix: string;
}

const CONFIG_PATH = process.env.SHADOW_CONFIG ?? path.join(__dirname, "shadow-config.json");

function loadConfig(): ShadowSyncConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      pairs: [],
      trailers: { replayed: "Shadow-replayed" },
      gitConfigOverrides: {},
      maxBuffer: 50 * 1024 * 1024,
      shadowBranchPrefix: "shadow",
    };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;

  const trailers = {
    replayed: ((doc.trailers as Record<string, string>)?.replayed) ?? "Shadow-replayed",
  };
  const gitConfigOverrides = (doc.gitConfigOverrides as Record<string, string>) ?? {};
  const maxBuffer = (doc.maxBuffer as number) ?? 50 * 1024 * 1024;
  const shadowBranchPrefix = (doc.shadowBranchPrefix as string) ?? "shadow";

  const pairs = (doc.pairs as SyncPair[]) ?? [];

  return { pairs, trailers, gitConfigOverrides, maxBuffer, shadowBranchPrefix };
}

const config = loadConfig();

export const PAIRS: SyncPair[] = [...config.pairs];
const REPLAYED_TRAILER = config.trailers.replayed;
let _shadowBranchPrefix = config.shadowBranchPrefix;
const MAX_BUFFER = config.maxBuffer;

/** Orchestrator repo root — git commands use paths relative to it, not the cwd. */
let _repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  .stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

export class ShadowSyncError extends Error {
  constructor(msg: string) { super(msg); this.name = "ShadowSyncError"; }
}

/** Mutates module state — call before each in-process runSync(). */
export function applyTestOverrides(opts: {
  repoRoot: string;
  pairs: SyncPair[];
  shadowBranchPrefix?: string;
}): void {
  _repoRoot = opts.repoRoot;
  PAIRS.length = 0;
  PAIRS.push(...opts.pairs);
  if (opts.shadowBranchPrefix != null) _shadowBranchPrefix = opts.shadowBranchPrefix;
}

export function fail(msg: string): never {
  throw new ShadowSyncError(`✘ ${msg}`);
}

/** Validate that a name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) fail(`${label} must not be empty.`);
  if (value.includes("..")) fail(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) fail(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) fail(`${label} must not start with '-'.`);
}

// ── Git primitives ────────────────────────────────────────────────────────────

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
export function git(args: string[], opts: GitOpts & { safe: true }): GitResult;
export function git(args: string[], opts?: GitOpts & { safe?: boolean }): string | GitResult {
  const fullArgs = opts?.plain ? args : [...GIT_CONFIG_OVERRIDES, ...args];
  const trim = (s: string) => opts?.raw ? s : s.trim();

  const r = spawnSync("git", fullArgs, {
    encoding: "utf8", cwd: opts?.cwd ?? _repoRoot, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
    ...(opts?.input != null ? { input: opts.input } : {}),
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });

  if (opts?.safe) {
    if (r.error) return { stdout: "", stderr: `Failed to spawn git: ${r.error.message}`, status: 1, ok: false };
    return {
      stdout: trim(r.stdout ?? ""),
      stderr: (r.stderr ?? "").trim(),
      status: r.status ?? 1,
      ok:     r.status === 0,
    };
  }

  if (r.error) throw new Error(`Failed to spawn git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`);
  return trim(r.stdout ?? "");
}

export function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", ref], { safe: true }).ok;
}

/** Check existence of multiple remote-tracking refs in a single git call. */
function filterExistingRefs(refs: string[]): Set<string> {
  if (refs.length === 0) return new Set();
  const result = git(
    ["for-each-ref", "--format=%(refname)", ...refs.map(r => `refs/remotes/${r}`)],
    { safe: true },
  );
  if (!result.ok || !result.stdout) return new Set();
  const existing = new Set<string>();
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    existing.add(line.replace(/^refs\/remotes\//, ""));
  }
  return existing;
}

export function listRemoteBranches(remote: string): string[] {
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""))
    .filter(b => !b.startsWith(`${_shadowBranchPrefix}/`));
}

export function shadowBranchName(pairName: string, branch: string): string {
  return `${_shadowBranchPrefix}/${pairName}/${branch}`;
}

/** Ensure a git remote is configured at the endpoint's URL — add or update as needed. */
export function ensureRemote(endpoint: RepoEndpoint): void {
  const existing = git(["remote", "get-url", endpoint.remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", endpoint.remote, endpoint.url]);
  } else if (existing.stdout !== endpoint.url) {
    git(["remote", "set-url", endpoint.remote, endpoint.url]);
  }
}

// ── Trailer machinery ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTrailerToken(s: string): string {
  return s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function replayedTrailerKey(remote: string): string {
  return `${REPLAYED_TRAILER}-${sanitizeTrailerToken(remote)}`;
}

/** Build a regex to match replay trailers: Shadow-replayed-{remote}: {hash} */
function replayedTrailerRegex(remote: string): RegExp {
  return new RegExp(`^${escapeRegex(replayedTrailerKey(remote))}:\\s*([0-9a-f]{7,40})`);
}

export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

function hasTrailer(trailers: string, key: string): boolean {
  return new RegExp(`^${escapeRegex(key)}:`, "m").test(trailers);
}

function stripReplayedTrailers(message: string): string {
  return message.split("\n")
    .filter(l => !l.startsWith(REPLAYED_TRAILER))
    .join("\n").trimEnd();
}

/**
 * Walk `git log` output where each commit is marked with `MARKER<hash>`
 * followed by its body. Calls `onLine(hash, line)` for every body line.
 */
function scanLogLines(logArgs: string[], onLine: (hash: string, line: string) => void): void {
  const MARKER = "SCANLOG ";
  const log = git([...logArgs, `--format=${MARKER}%H%n%B`], { safe: true });
  if (!log.ok || !log.stdout) return;
  let currentHash: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentHash = line.slice(MARKER.length).trim();
      continue;
    }
    if (currentHash) onLine(currentHash, line);
  }
}

function extractTrailerMapping(logArgs: string[], trailerRe: RegExp): Map<string, string> {
  const mapping = new Map<string, string>();
  scanLogLines(logArgs, (hash, line) => {
    const match = line.match(trailerRe);
    if (match) mapping.set(match[1], hash);
  });
  return mapping;
}

/** Trailer keys/regexes resolved for one replay direction. */
interface DirectionConfig {
  addTrailerKey: string;
  scanRe: RegExp;
  skipTrailerKey: string;
  skipScanRe: RegExp;
}

function buildDirectionConfig(sourceRemote: string, targetRemote: string): DirectionConfig {
  return {
    addTrailerKey: replayedTrailerKey(sourceRemote),
    scanRe: replayedTrailerRegex(sourceRemote),
    skipTrailerKey: replayedTrailerKey(targetRemote),
    skipScanRe: replayedTrailerRegex(targetRemote),
  };
}

// ── Preflight checks ──────────────────────────────────────────────────────────

type PreflightWarning = { level: "error" | "warn"; code: string; message: string };

export function runPreflightChecks(ref: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  // core.ignorecase=true (Windows/macOS default) folds case-conflicting paths
  // in update-index --index-info, silently dropping one of them from the
  // replayed tree. Skip the walk on Linux where the index preserves both.
  if (process.platform === "win32" || process.platform === "darwin") {
    const tree = git(["ls-tree", "-r", "--name-only", ref], { safe: true });
    if (tree.ok && tree.stdout) {
      const lower = new Map<string, string>();
      for (const filePath of tree.stdout.split("\n").filter(Boolean)) {
        const existing = lower.get(filePath.toLowerCase());
        if (existing && existing !== filePath) {
          error("CASE_CONFLICT", `Case conflict: '${existing}' and '${filePath}' differ only in case.\n  This will cause data loss on case-insensitive filesystems (Windows/macOS).`);
        }
        lower.set(filePath.toLowerCase(), filePath);
      }
    }
  }

  return warnings;
}

/** Pure (no I/O) — see printPreflightResults for the side-effecting version. */
export function formatPreflightResults(warnings: PreflightWarning[]): { lines: string[]; errorCount: number; ok: boolean } {
  const lines = warnings.map(w => `${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) lines.push(`\nAborting due to ${errorCount} error(s).`);
  return { lines, errorCount, ok: errorCount === 0 };
}

export function printPreflightResults(warnings: PreflightWarning[]): boolean {
  const { lines, ok } = formatPreflightResults(warnings);
  for (const line of lines) console.error(line);
  return ok;
}

// ── Commit metadata & collection ──────────────────────────────────────────────

interface CommitMeta {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  trailers: string;
  short: string;
}

function getCommitMeta(hash: string): CommitMeta {
  // NUL-separated; %B last so its newlines can't shift fields.
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%h: %s", "%(trailers:only,unfold=true)", "%B"]
    .join("%x00");
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split("\0");
  return {
    hash,
    authorName: parts[0],
    authorEmail: parts[1],
    authorDate: parts[2],
    committerName: parts[3],
    committerEmail: parts[4],
    committerDate: parts[5],
    short: parts[6],
    trailers: parts[7],
    message: parts[8],
  };
}

function buildCommitEnv(meta: CommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: meta.authorName,
    GIT_AUTHOR_EMAIL: meta.authorEmail,
    GIT_AUTHOR_DATE: meta.authorDate,
    GIT_COMMITTER_NAME: meta.committerName,
    GIT_COMMITTER_EMAIL: meta.committerEmail,
    GIT_COMMITTER_DATE: meta.committerDate,
  };
}

interface TopoCommit {
  hash: string;
  parents: string[];
}

/**
 * `--no-walk` bypasses path-filter simplification, which would silently drop
 * merge parents TREESAME at the path. Chunked for argv limits.
 */
function fetchTrueParents(hashes: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (hashes.length === 0) return map;
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const result = git(["log", "--no-walk", "--format=%H %P", ...chunk], { safe: true });
    if (!result.ok || !result.stdout) continue;
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/).filter(Boolean);
      map.set(parts[0], parts.slice(1));
    }
  }
  return map;
}

function collectCommitsWithTrueParents(revListArgs: string[]): TopoCommit[] {
  const result = git(revListArgs, { safe: true });
  if (!result.ok || !result.stdout) return [];
  const hashes = result.stdout.split("\n").filter(Boolean);
  const parentsMap = fetchTrueParents(hashes);
  return hashes.map(hash => ({ hash, parents: parentsMap.get(hash) ?? [] }));
}

function collectSourceCommits(source: RepoEndpoint, branches: string[]): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse",
    ...branches.map(b => `${source.remote}/${b}`)];
  if (source.dir) args.push("--", `${source.dir}/`);
  return collectCommitsWithTrueParents(args);
}

// ── Tree composition & parent resolution ──────────────────────────────────────

/** Compile a .shadowignore pattern (supports * and ** globs) into a regex. */
function compileIgnorePattern(pattern: string): RegExp {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "<<GLOBSTAR_SLASH>>")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR_SLASH>>/g, "(.*/)?")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`);
}

/**
 * Apply this commit's diff (vs first parent) to parentTree. Root commits
 * are treated as additions of every file in sourceDir.
 */
function buildReplayedTree(opts: {
  commitHash: string;
  sourceDir: string;
  targetDir: string;
  parentTree: string | null;
  tmpIndex: string;
  shadowIgnorePatterns: RegExp[];
}): string | null {
  const { commitHash, sourceDir, targetDir, parentTree, tmpIndex, shadowIgnorePatterns } = opts;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  if (parentTree) {
    git(["read-tree", parentTree], { env: idxEnv });
  } else {
    git(["read-tree", "--empty"], { env: idxEnv });
  }

  // diff-tree -r format: :oldmode newmode oldhash newhash status\tpath
  const sourceParent = git(["rev-parse", `${commitHash}^`], { safe: true });
  let diffOutput: string;

  if (sourceParent.ok) {
    const diffArgs = ["diff-tree", "-r", sourceParent.stdout, commitHash];
    if (sourceDir) diffArgs.push("--", `${sourceDir}/`);
    diffOutput = git(diffArgs, { safe: true }).stdout;
  } else {
    const lsArgs = ["ls-tree", "-r", commitHash];
    if (sourceDir) lsArgs.push("--", `${sourceDir}/`);
    const lsResult = git(lsArgs, { safe: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
    // Reshape ls-tree into diff-tree's "A" entries.
    diffOutput = lsResult.stdout.split("\n").filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/);
        if (!m) return "";
        return `:000000 ${m[1]} ${"0".repeat(40)} ${m[2]} A\t${m[3]}`;
      }).join("\n");
  }

  if (!diffOutput) return parentTree ?? null;

  // No -M/-C above, so renames surface as D+A — we only handle A/M/D/T.
  const removals: string[] = [];
  const additions: string[] = [];   // "mode hash\tpath" lines for --index-info
  for (const line of diffOutput.split("\n").filter(Boolean)) {
    const m = line.match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([AMDT])\t(.+)$/);
    if (!m) continue;
    const [, newMode, newHash, status, filePath] = m;

    let srcRelative = filePath;
    if (sourceDir) {
      if (!srcRelative.startsWith(`${sourceDir}/`)) continue;
      srcRelative = srcRelative.slice(sourceDir.length + 1);
    }

    if (shadowIgnorePatterns.some(p => p.test(srcRelative))) continue;

    const targetPath = targetDir ? `${targetDir}/${srcRelative}` : srcRelative;

    if (status === "D") {
      removals.push(targetPath);
    } else {
      additions.push(`${newMode} ${newHash}\t${targetPath}`);
    }
  }

  if (removals.length > 0) {
    git(["rm", "--cached", "-f", "--quiet", "--", ...removals], { env: idxEnv, safe: true });
  }

  if (additions.length > 0) {
    git(["update-index", "--index-info"], { env: idxEnv, input: additions.join("\n") + "\n" });
  }

  return git(["write-tree"], { env: idxEnv });
}

/** Splice `subtreeContent` into `baseTree` at `subdir/`, replacing what was there. */
function composeSubtree(baseTree: string, subdir: string, subtreeContent: string): string {
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-compose-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };
  try {
    git(["read-tree", baseTree], { env: idxEnv });
    // Clear any existing entries under subdir so --prefix read-tree can succeed.
    git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", subdir], { env: idxEnv, safe: true });
    git(["read-tree", `--prefix=${subdir}/`, subtreeContent], { env: idxEnv });
    return git(["write-tree"], { env: idxEnv });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/**
 * Cross-repo merge: splice the shadow chain's target.dir/ over the echo'd
 * parent's outer files, so checking out an old shadow commit reflects the
 * target's outer state then — not a frozen bootstrap snapshot. Returns null
 * to fall back to the plain first-parent tree.
 */
function composeCrossRepoMergeTree(opts: {
  commit: TopoCommit;
  mappedParents: string[];
  target: RepoEndpoint;
  shaMapping: Map<string, string>;
  dc: DirectionConfig;
}): string | null {
  const { commit, mappedParents, target, shaMapping, dc } = opts;
  if (!target.dir || mappedParents.length === 0) return null;

  let echoTargetSHA: string | null = null;
  for (const sourceParent of commit.parents) {
    const parentMeta = getCommitMeta(sourceParent);
    if (hasTrailer(parentMeta.trailers, dc.skipTrailerKey)) {
      const mapped = shaMapping.get(sourceParent);
      if (mapped) {
        echoTargetSHA = mapped;
        break;
      }
    }
  }
  if (!echoTargetSHA) return null;

  const echoTreeRes = git(["rev-parse", `${echoTargetSHA}^{tree}`], { safe: true });
  if (!echoTreeRes.ok) return null;
  const shadowDirRes = git(["rev-parse", `${mappedParents[0]}:${target.dir}`], { safe: true });
  if (!shadowDirRes.ok) return echoTreeRes.stdout;
  return composeSubtree(echoTreeRes.stdout, target.dir, shadowDirRes.stdout);
}

/** Echo anchor: closest mapped ancestor of `parentHash`, or null if disjoint. */
function findEchoAnchor(parentHash: string, shaMapping: Map<string, string>): string | null {
  const result = git(["log", "--topo-order", "--format=%H", parentHash], { safe: true });
  if (!result.ok) return null;
  for (const line of result.stdout.split("\n")) {
    const hash = line.trim();
    if (!hash) continue;
    const mapped = shaMapping.get(hash);
    if (mapped) return mapped;
  }
  return null;
}

function resolveTargetParents(
  commit: TopoCommit,
  shaMapping: Map<string, string>,
  targetInit: string | null,
): string[] {
  // Orphan parents anchor at the closest echo'd ancestor, then targetInit —
  // never target/main's tip, which would silently revert outer files at merge.
  if (commit.parents.length === 0) {
    return targetInit ? [targetInit] : [];
  }
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const parentHash of commit.parents) {
    const mapped = shaMapping.get(parentHash)
      ?? findEchoAnchor(parentHash, shaMapping)
      ?? targetInit;
    if (mapped && !seen.has(mapped)) {
      parents.push(mapped);
      seen.add(mapped);
    }
  }
  return parents;
}

// ── Mirror orchestration ──────────────────────────────────────────────────────

/**
 * Source→target SHA mapping from this pair's shadow branches only.
 * No --all fallback: trailers don't encode the pair name, so cross-pair
 * scans would pick up unrelated mappings sharing a source remote.
 */
function loadReplayedMappings(opts: {
  pair: SyncPair;
  target: RepoEndpoint;
  branches: string[];
  dc: DirectionConfig;
}): Map<string, string> {
  const { pair, target, branches, dc } = opts;
  const candidateRefs = branches.map(b => `${target.remote}/${shadowBranchName(pair.name, b)}`);
  const existingRefs = filterExistingRefs(candidateRefs);
  const shadowRefs = candidateRefs.filter(r => existingRefs.has(r));

  if (shadowRefs.length === 0) {
    return new Map();
  }
  return extractTrailerMapping(
    ["log", ...shadowRefs, `--grep=^${dc.addTrailerKey}`],
    dc.scanRe,
  );
}

/**
 * Drop already-replayed and echoed commits. Echoes get echo→original
 * recorded in shaMapping so parent resolution reuses the real target SHA
 * rather than re-replaying or falling back to the branch tip.
 */
function filterNotReplayedCommits(
  allCommits: TopoCommit[],
  shaMapping: Map<string, string>,
  dc: DirectionConfig,
): TopoCommit[] {
  return allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const meta = getCommitMeta(c.hash);
    if (!hasTrailer(meta.trailers, dc.skipTrailerKey)) return true;
    const match = meta.trailers.split("\n")
      .map(l => l.match(dc.skipScanRe))
      .find(m => m);
    if (match && refExists(match[1])) {
      shaMapping.set(c.hash, match[1]);
    }
    return false;
  });
}

/**
 * Newest-first walk to each branch's most recent mapped ancestor. The branch
 * HEAD may be outer-only (didn't touch source.dir/), so we still advance the
 * shadow tip to the most recent commit inside the synced subdir.
 */
function mapBranchesToTargetTips(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const log = git(["rev-list", "--topo-order", `${remote}/${branch}`], { safe: true });
    if (!log.ok) continue;
    for (const line of log.stdout.split("\n")) {
      const hash = line.trim();
      if (!hash) continue;
      const replayed = shaMapping.get(hash);
      if (replayed) {
        branchMapping.set(branch, replayed);
        break;
      }
    }
  }
  return branchMapping;
}

/**
 * Replay newCommits in topo order, mutating `shaMapping` so each replayed
 * commit is visible to later parent resolution in the same batch.
 */
function replayCommits(opts: {
  newCommits: TopoCommit[];
  shaMapping: Map<string, string>;
  targetInit: string | null;
  source: RepoEndpoint;
  target: RepoEndpoint;
  dc: DirectionConfig;
}): void {
  const { newCommits, shaMapping, targetInit, source, target, dc } = opts;
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-replay-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );

  let lastTree: string | null = null;
  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);

      // Carries our own trailer → forwarded earlier and merged back; record only.
      const isEcho = hasTrailer(meta.trailers, dc.addTrailerKey);

      if (isEcho) {
        console.log(`  Skipping ${meta.short} (echo from other direction).`);
      } else {
        const label = commit.parents.length > 1
          ? `merge commit ${meta.short}`
          : commit.parents.length === 0
            ? `root commit ${meta.short}`
            : meta.short;
        console.log(`  Replaying ${label}...`);
      }

      const mappedParents = resolveTargetParents(commit, shaMapping, targetInit);

      // Cross-repo merge tree (see composeCrossRepoMergeTree).
      const composedParentTree = composeCrossRepoMergeTree({ commit, mappedParents, target, shaMapping, dc });
      const parentTree: string | null = composedParentTree
        ?? (mappedParents.length > 0
          ? git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true }).stdout || lastTree
          : lastTree);

      const ignorePath = source.dir ? `${source.dir}/.shadowignore` : ".shadowignore";
      const ignoreContent = git(["show", `${commit.hash}:${ignorePath}`], { safe: true });
      const shadowIgnorePatterns = ignoreContent.ok && ignoreContent.stdout
        ? ignoreContent.stdout.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(compileIgnorePattern)
        : [];

      const tree = buildReplayedTree({
        commitHash: commit.hash,
        sourceDir: source.dir,
        targetDir: target.dir,
        parentTree,
        tmpIndex,
        shadowIgnorePatterns,
      });

      if (!tree) {
        console.log(`  Skipping ${meta.short} (source content missing).`);
        continue;
      }

      const msg = isEcho
        ? appendTrailer(stripReplayedTrailers(meta.message), `${dc.addTrailerKey}: ${commit.hash}`)
        : appendTrailer(meta.message, `${dc.addTrailerKey}: ${commit.hash}`);

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", msg], {
        env: buildCommitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      lastTree = tree;
      console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** Replay one side of a pair onto the other; `from` selects the source. */
export function mirrorHistory(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { pair, from, branches } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = buildDirectionConfig(source.remote, target.remote);

  console.log("Scanning history for already-replayed commits...");
  const shaMapping = loadReplayedMappings({ pair, target, branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  const allCommits = collectSourceCommits(source, branches);
  const newCommits = filterNotReplayedCommits(allCommits, shaMapping, dc);

  if (newCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: mapBranchesToTargetTips(source.remote, branches, shaMapping),
      upToDate: true,
    };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  // Fallback root for orphan parents (see resolveTargetParents).
  const targetInit = refExists(`${target.remote}/main`)
    ? (git(["rev-list", "--max-parents=0", `${target.remote}/main`], { safe: true })
        .stdout.split("\n")[0] || null)
    : null;

  replayCommits({ newCommits, shaMapping, targetInit, source, target, dc });

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) replayed.`);

  return {
    mirrored: newCommits.length,
    branchMapping: mapBranchesToTargetTips(source.remote, branches, shaMapping),
    upToDate: false,
  };
}
