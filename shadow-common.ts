import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  /** Git remote name */
  remote: string;
  /** URL for the repo */
  url: string;
  /** Path prefix in this repo ("backend", "" for root) */
  dir: string;
}

export interface SyncPair {
  /** Stable identifier — used in shadow branch names. */
  name: string;
  /** The two repo endpoints. Symmetric — direction is chosen at runtime via --from. */
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
    // No config file — return defaults (tests override via applyTestOverrides)
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

// ── Core utilities ───────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;

/** Orchestrator repo root — git commands use paths relative to it, not the cwd. */
let _repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  .stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

// ── Test overrides ───────────────────────────────────────────────────────────

export class ShadowSyncError extends Error {
  constructor(msg: string) { super(msg); this.name = "ShadowSyncError"; }
}

/**
 * Override module-level state for in-process testing.
 * Call before each in-process sync invocation.
 */
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

export function die(msg: string): never {
  throw new ShadowSyncError(`✘ ${msg}`);
}

/** Validate that a name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) die(`${label} must not be empty.`);
  if (value.includes("..")) die(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) die(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) die(`${label} must not start with '-'.`);
}

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
function refsExist(refs: string[]): Set<string> {
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

export function listBranches(remote: string): string[] {
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

export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
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

// ── Pre-flight checks ─────────────────────────────────────────────────────────

export function preflightChecks(ref: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const warn  = (code: string, message: string) => warnings.push({ level: "warn", code, message });
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  const tree = git(["ls-tree", "-r", "--long", ref], { safe: true });
  if (tree.ok && tree.stdout) {
    const paths: string[] = [];
    for (const entry of tree.stdout.split("\n").filter(Boolean)) {
      const m = entry.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\s+[\d-]+\t(.+)$/);
      if (!m) continue;
      const [, mode, , filePath] = m;
      paths.push(filePath);
      if (mode === "160000") warn("SUBMODULE", `Contains a submodule at '${filePath}'. Submodules cannot be synced and will be skipped.`);
      if (mode === "120000") warn("SYMLINK", `Contains a symlink at '${filePath}'. Symlink targets are not adjusted for the subdirectory.`);
    }

    if (process.platform === "win32" || process.platform === "darwin") {
      const lower = new Map<string, string>();
      for (const p of paths) {
        const existing = lower.get(p.toLowerCase());
        if (existing && existing !== p) {
          error("CASE_CONFLICT", `Case conflict: '${existing}' and '${p}' differ only in case.\n  This will cause data loss on case-insensitive filesystems (Windows/macOS).`);
        }
        lower.set(p.toLowerCase(), p);
      }
    }
  }

  const attrs = git(["show", `${ref}:.gitattributes`], { safe: true });
  if (attrs.ok && attrs.stdout.includes("filter=lfs")) {
    warn("GIT_LFS", "Uses Git LFS. Shadow sync will transfer LFS pointer files, not actual content.");
  }

  return warnings;
}

type PreflightWarning = { level: "error" | "warn"; code: string; message: string };

/** Pure formatter: turns warnings into stderr lines plus a pass/fail decision. */
export function formatPreflightResults(warnings: PreflightWarning[]): { lines: string[]; errorCount: number; ok: boolean } {
  const lines = warnings.map(w => `${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) lines.push(`\nAborting due to ${errorCount} error(s).`);
  return { lines, errorCount, ok: errorCount === 0 };
}

export function handlePreflightResults(warnings: PreflightWarning[]): boolean {
  const { lines, ok } = formatPreflightResults(warnings);
  for (const line of lines) console.error(line);
  return ok;
}

// ── Replay engine ─────────────────────────────────────────────────────────────

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
  // NUL-separated fields. %B (message) goes last so any internal newlines
  // can't shift field positions. Commit messages cannot contain NUL bytes,
  // so split("\0") is unambiguous.
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

function commitEnv(meta: CommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: meta.authorName,
    GIT_AUTHOR_EMAIL: meta.authorEmail,
    GIT_AUTHOR_DATE: meta.authorDate,
    GIT_COMMITTER_NAME: meta.committerName,
    GIT_COMMITTER_EMAIL: meta.committerEmail,
    GIT_COMMITTER_DATE: meta.committerDate,
  };
}

function stripTrailers(message: string): string {
  return message.split("\n")
    .filter(l => !l.startsWith(REPLAYED_TRAILER))
    .join("\n").trimEnd();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeTokenPart(s: string): string {
  return s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function replayedTrailerKey(remote: string): string {
  return `${REPLAYED_TRAILER}-${sanitizeTokenPart(remote)}`;
}

/** Build a regex to match replay trailers: Shadow-replayed-{remote}: {hash} */
function replayedHashRe(remote: string): RegExp {
  return new RegExp(`^${escapeRegex(replayedTrailerKey(remote))}:\\s*([0-9a-f]{7,40})`);
}

/**
 * Walk `git log` output where each commit is marked with `MARKER<hash>`
 * followed by its body. Calls `onLine(hash, line)` for every body line.
 */
function scanLogCommits(logArgs: string[], onLine: (hash: string, line: string) => void): void {
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

// ── Shared helpers ──────────────────────────────────────────────────────────

interface TopoCommit {
  hash: string;
  parents: string[];
}

/**
 * Fetch true parents for the given commit hashes via `git log --no-walk`.
 * Bypasses path-filter history simplification, which silently drops merge
 * parents whose ancestors are TREESAME at the path. Without this, a merge
 * that brought changes from a branch we don't sync would lose the parent
 * edge to its first parent on replay.
 *
 * Batched in chunks to stay under OS argv limits on large histories.
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

function buildTrailerMapping(logArgs: string[], trailerRe: RegExp): Map<string, string> {
  const mapping = new Map<string, string>();
  scanLogCommits(logArgs, (hash, line) => {
    const match = line.match(trailerRe);
    if (match) mapping.set(match[1], hash);
  });
  return mapping;
}

/**
 * Walk `parentHash`'s source-side ancestry in topo order, returning the
 * mapped value of the closest commit already in `shaMapping`. Used by M2 as
 * the "echo anchor" — the most recent shared point between source and target.
 * Returns null when no ancestor has been mapped (truly disjoint history).
 */
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

function resolveParents(
  commit: TopoCommit,
  shaMapping: Map<string, string>,
  targetInit: string | null,
): string[] {
  // M2: an unmapped parent (or a root commit) anchors at the closest echo'd
  // ancestor's mapped value, falling back to target's init commit when no
  // echo exists in the ancestry. Anchoring at init (rather than target/main's
  // current tip) keeps merge-base aligned with the most recent round-trip
  // instead of jumping ahead to outer-only commits the consumer made between
  // syncs — which is what would silently revert non-pair files at merge time.
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

function hasTrailerLine(trailers: string, key: string): boolean {
  return new RegExp(`^${escapeRegex(key)}:`, "m").test(trailers);
}

/**
 * Build a remapped tree by applying the source commit's diff (against its
 * first parent) to the previous replayed tree. Only files that actually
 * changed in the source commit are touched — producing clean, minimal diffs.
 *
 * For root commits (no parent), all files in sourceDir are treated as added.
 */
function buildRemappedTree(opts: {
  commitHash: string;
  sourceDir: string;
  targetDir: string;
  parentTree: string | null;
  tmpIndex: string;
  shadowIgnorePatterns: RegExp[];
}): string | null {
  const { commitHash, sourceDir, targetDir, parentTree, tmpIndex, shadowIgnorePatterns } = opts;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  // Start from the previous replayed commit's tree (or empty for the first)
  if (parentTree) {
    git(["read-tree", parentTree], { env: idxEnv });
  } else {
    git(["read-tree", "--empty"], { env: idxEnv });
  }

  // Compute what changed in the source commit.
  // diff-tree -r gives: :oldmode newmode oldhash newhash status\tpath
  const sourceParent = git(["rev-parse", `${commitHash}^`], { safe: true });
  let diffOutput: string;

  if (sourceParent.ok) {
    // Normal commit — diff against first parent, scoped to sourceDir
    const diffArgs = ["diff-tree", "-r", sourceParent.stdout, commitHash];
    if (sourceDir) diffArgs.push("--", `${sourceDir}/`);
    diffOutput = git(diffArgs, { safe: true }).stdout;
  } else {
    // Root commit — list all files as additions
    const lsArgs = ["ls-tree", "-r", commitHash];
    if (sourceDir) lsArgs.push("--", `${sourceDir}/`);
    const lsResult = git(lsArgs, { safe: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
    // Convert ls-tree format to diff-tree-like "A" entries
    diffOutput = lsResult.stdout.split("\n").filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/);
        if (!m) return "";
        return `:000000 ${m[1]} ${"0".repeat(40)} ${m[2]} A\t${m[3]}`;
      }).join("\n");
  }

  if (!diffOutput) return parentTree ?? null;

  // Parse and apply each change. diff-tree is invoked without -M/-C above,
  // so renames/copies surface as D+A pairs — we only handle A/M/D/T here.
  const removals: string[] = [];
  const additions: string[] = [];   // "mode hash\tpath" lines for --index-info
  for (const line of diffOutput.split("\n").filter(Boolean)) {
    const m = line.match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([AMDT])\t(.+)$/);
    if (!m) continue;
    const [, newMode, newHash, status, filePath] = m;

    // Map source path to target path
    let srcRelative = filePath;
    if (sourceDir) {
      if (!srcRelative.startsWith(`${sourceDir}/`)) continue;
      srcRelative = srcRelative.slice(sourceDir.length + 1);
    }

    // Skip files matching .shadowignore patterns
    if (shadowIgnorePatterns.some(p => p.test(srcRelative))) continue;

    const targetPath = targetDir ? `${targetDir}/${srcRelative}` : srcRelative;

    if (status === "D") {
      removals.push(targetPath);
    } else {
      additions.push(`${newMode} ${newHash}\t${targetPath}`);
    }
  }

  // Batch-remove deleted paths (single spawn)
  if (removals.length > 0) {
    git(["rm", "--cached", "-f", "--quiet", "--", ...removals], { env: idxEnv, safe: true });
  }

  // Batch-add/update entries via --index-info (single spawn)
  if (additions.length > 0) {
    git(["update-index", "--index-info"], { env: idxEnv, input: additions.join("\n") + "\n" });
  }

  return git(["write-tree"], { env: idxEnv });
}

/**
 * For a merge commit whose parents straddle the two repos — one shadow-side
 * (non-echo) parent and one echo'd target-side parent (carries the skip
 * trailer pointing back to a commit on the target) — build a parent tree
 * that combines:
 *   - outer (non-target.dir) files from the echo'd parent (work-branch state)
 *   - target.dir/ subtree from the shadow chain's first mapped parent
 *
 * Returns null when no echo'd parent is found, target.dir is empty, or the
 * echo'd target-side tree can't be resolved — caller falls back to the
 * standard first-parent tree.
 */
function crossRepoMerge(opts: {
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
    if (hasTrailerLine(parentMeta.trailers, dc.skipTrailerKey)) {
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

/**
 * Produce a new tree that equals `baseTree` with `subdir/` replaced by
 * `subtreeContent`. Used to keep shadow branches carrying the target side's
 * *current* non-pair content rather than the snapshot the replay chain
 * would otherwise freeze at its first commit.
 */
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
 * Two-step rev-list: select hashes via the given args, then fetch true
 * parents via `git log --no-walk` to bypass any path-filter simplification
 * that would have rewritten merge parents. See `fetchTrueParents`.
 */
function collectWithTrueParents(revListArgs: string[]): TopoCommit[] {
  const result = git(revListArgs, { safe: true });
  if (!result.ok || !result.stdout) return [];
  const hashes = result.stdout.split("\n").filter(Boolean);
  const parentsMap = fetchTrueParents(hashes);
  return hashes.map(hash => ({ hash, parents: parentsMap.get(hash) ?? [] }));
}

/** Collect source commits in topo order, optionally scoped to source.dir/. */
function collectSourceCommits(source: RepoEndpoint, branches: string[]): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse",
    ...branches.map(b => `${source.remote}/${b}`)];
  if (source.dir) args.push("--", `${source.dir}/`);
  return collectWithTrueParents(args);
}

/**
 * Map each source branch to its corresponding replayed tip on the target.
 *
 * Walks the branch's history newest-first looking for the most recent ancestor
 * that landed in `shaMapping`. The branch HEAD itself may be an outer-only
 * commit (didn't touch source.dir/) and therefore not in the mapping — in
 * that case we still want to advance the shadow branch to the most recent
 * commit that *did* touch the synced subdir.
 */
function buildBranchMapping(
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

// ── Unified replay ──────────────────────────────────────────────────────────

interface DirectionConfig {
  addTrailerKey: string;
  scanRe: RegExp;
  skipTrailerKey: string;
  skipScanRe: RegExp;
}

/**
 * Build direction config from remote names.
 * Trailer format: "Shadow-replayed-{remote}: {hash}" — remote is sanitized
 * into the key so git's trailer parser (strict `[A-Za-z0-9-]+` token
 * grammar) recognizes it. When replaying from source, skip commits tagged
 * with the target's remote (they originated from the target and were
 * already replayed back).
 */
function directionConfig(sourceRemote: string, targetRemote: string): DirectionConfig {
  return {
    /** Trailer key to add: "Shadow-replayed-{sourceRemote}" — value is the hash */
    addTrailerKey: replayedTrailerKey(sourceRemote),
    /** Regex to scan for already-replayed commits from this source */
    scanRe: replayedHashRe(sourceRemote),
    /** Trailer key to skip: commits tagged with the target's remote came from there */
    skipTrailerKey: replayedTrailerKey(targetRemote),
    /** Regex to extract the original target-side hash from a skipped commit's trailer */
    skipScanRe: replayedHashRe(targetRemote),
  };
}

/**
 * Build the source→target SHA mapping from existing replayed commits
 * on the target side. Scans only the target's own shadow branches for this
 * pair — no cross-pair `--all` fallback, because the
 * `Shadow-replayed-{sourceRemote}` trailer doesn't encode the pair name,
 * so a broader scan would pick up trailers from other pairs that happen
 * to share the same source remote.
 */
function scanReplayedMapping(opts: {
  pair: SyncPair;
  target: RepoEndpoint;
  branches: string[];
  dc: DirectionConfig;
}): Map<string, string> {
  const { pair, target, branches, dc } = opts;
  const candidateRefs = branches.map(b => `${target.remote}/${shadowBranchName(pair.name, b)}`);
  const existingRefs = refsExist(candidateRefs);
  const shadowRefs = candidateRefs.filter(r => existingRefs.has(r));

  if (shadowRefs.length === 0) {
    return new Map();
  }
  return buildTrailerMapping(
    ["log", ...shadowRefs, `--grep=^${dc.addTrailerKey}`],
    dc.scanRe,
  );
}

/**
 * Walk newCommits in topo order, building each replayed tree by diff-applying
 * the source commit onto the previous tree, then committing with the original
 * author/committer identity and an added trailer.
 *
 * `shaMapping` is mutated: every replayed source hash is recorded so later
 * commits in the same batch can resolve their parents.
 */
function runReplayLoop(opts: {
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

      // Commits that already carry our own add-trailer were forwarded by us
      // and round-tripped back to source via a merge — record but don't replay.
      const isEcho = hasTrailerLine(meta.trailers, dc.addTrailerKey);

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

      const mappedParents = resolveParents(commit, shaMapping, targetInit);

      // M9: cross-repo merges (one shadow-side parent, one echo'd target-side
      // parent) get a composed parent tree so shadow's intermediate commits'
      // outer state stays aligned with the most recent round-tripped commit
      // — checking out an old shadow commit reflects the target's outer at
      // that point rather than a frozen bootstrap snapshot.
      const composedParentTree = crossRepoMerge({ commit, mappedParents, target, shaMapping, dc });
      const parentTree: string | null = composedParentTree
        ?? (mappedParents.length > 0
          ? git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true }).stdout || lastTree
          : lastTree);

      // Load .shadowignore from this commit's tree
      const ignorePath = source.dir ? `${source.dir}/.shadowignore` : ".shadowignore";
      const ignoreContent = git(["show", `${commit.hash}:${ignorePath}`], { safe: true });
      const shadowIgnorePatterns = ignoreContent.ok && ignoreContent.stdout
        ? ignoreContent.stdout.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(compileIgnorePattern)
        : [];

      const tree = buildRemappedTree({
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
        ? appendTrailer(stripTrailers(meta.message), `${dc.addTrailerKey}: ${commit.hash}`)
        : appendTrailer(meta.message, `${dc.addTrailerKey}: ${commit.hash}`);

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", msg], {
        env: commitEnv(meta),
      });

      shaMapping.set(commit.hash, newSHA);
      lastTree = tree;
      console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/**
 * Drop commits that are already replayed or were echoed back from the target.
 *
 * For echoed commits (those carrying the target's replayed trailer), extract
 * the original target-side hash from the trailer and — when that commit still
 * exists locally — record echo → original in shaMapping. Downstream parent
 * resolution then re-uses the original target commit directly (same SHA),
 * instead of creating a new replayed copy or falling back to the target's
 * current branch tip. This keeps ancestry aligned across repos so later merges
 * find the real common ancestor.
 */
function filterNewCommits(
  allCommits: TopoCommit[],
  shaMapping: Map<string, string>,
  dc: DirectionConfig,
): TopoCommit[] {
  return allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const meta = getCommitMeta(c.hash);
    if (!hasTrailerLine(meta.trailers, dc.skipTrailerKey)) return true;
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
 * Replay commits from one side of a pair to the other.
 *
 * @param from - "a" or "b": which side's commits to replay
 * @param branches - branches to replay (resolved as remote-tracking refs on the source)
 */
export function replayCommits(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { pair, from, branches } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = directionConfig(source.remote, target.remote);

  console.log("Scanning history for already-replayed commits...");
  const shaMapping = scanReplayedMapping({ pair, target, branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  const allCommits = collectSourceCommits(source, branches);
  const newCommits = filterNewCommits(allCommits, shaMapping, dc);

  if (newCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: buildBranchMapping(source.remote, branches, shaMapping),
      upToDate: true,
    };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  // M2: orphans anchor at target's init commit (or the closest echo'd
  // ancestor when one exists in the unmapped parent's history). Pinning to
  // init keeps merge-base aligned with the most recent round-trip rather
  // than jumping to target/main's current tip and shadowing outer-only
  // commits made between syncs.
  const targetInit = refExists(`${target.remote}/main`)
    ? (git(["rev-list", "--max-parents=0", `${target.remote}/main`], { safe: true })
        .stdout.split("\n")[0] || null)
    : null;

  runReplayLoop({ newCommits, shaMapping, targetInit, source, target, dc });

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) replayed.`);

  return {
    mirrored: newCommits.length,
    branchMapping: buildBranchMapping(source.remote, branches, shaMapping),
    upToDate: false,
  };
}
