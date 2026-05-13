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
    if (!result.ok) {
      fail(`Failed to fetch parents for ${chunk.length} commit(s): ${result.stderr}`);
    }
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/).filter(Boolean);
      map.set(parts[0], parts.slice(1));
    }
  }
  return map;
}

function collectCommitsWithTrueParents(revListArgs: string[]): TopoCommit[] {
  const result = git(revListArgs, { safe: true });
  if (!result.ok) fail(`rev-list failed (${revListArgs.join(" ")}): ${result.stderr}`);
  if (!result.stdout) return [];
  const hashes = result.stdout.split("\n").filter(Boolean);
  const parentsMap = fetchTrueParents(hashes);
  return hashes.map(hash => ({ hash, parents: parentsMap.get(hash) ?? [] }));
}

function collectSourceCommits(source: RepoEndpoint, branches: string[]): TopoCommit[] {
  // --full-history is required when source.dir is non-empty: rev-list's default
  // history simplification drops consumer-merges TREESAME to a parent at the
  // path, which silently loses concurrent-merge round descendants and breaks
  // C6's FF-only invariant. See M1 (where the splice + --full-history pairing
  // is described) and C6 (the push-time invariant it protects).
  const args = ["rev-list", "--topo-order", "--reverse", "--full-history",
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
    const diffRes = git(diffArgs, { safe: true });
    if (!diffRes.ok) {
      fail(`diff-tree failed for ${commitHash}: ${diffRes.stderr}`);
    }
    diffOutput = diffRes.stdout;
  } else {
    // Source root has no parent tree to diff against — reshape ls-tree into diff-tree's "A" entries so downstream logic sees a normal diff.
    const lsArgs = ["ls-tree", "-r", commitHash];
    if (sourceDir) lsArgs.push("--", `${sourceDir}/`);
    const lsResult = git(lsArgs, { safe: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
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

/** Allocate a private git index, run `fn` against it, then delete it. */
function withTmpIndex<T>(label: string, fn: (idxEnv: { GIT_INDEX_FILE: string }) => T): T {
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    return fn({ GIT_INDEX_FILE: tmpIndex });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** Build a tree from `refOrTree` with `subdir/` stripped out — the "outer" slice. */
function outerOnlyTree(refOrTree: string, subdir: string): string {
  return withTmpIndex("outer", idxEnv => {
    git(["read-tree", refOrTree], { env: idxEnv });
    git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--", subdir], { env: idxEnv, safe: true });
    return git(["write-tree"], { env: idxEnv });
  });
}

/** Splice `subtreeContent` into `baseTree` at `subdir/`, replacing what was there. */
function composeSubtree(baseTree: string, subdir: string, subtreeContent: string): string {
  return withTmpIndex("compose", idxEnv => {
    git(["read-tree", baseTree], { env: idxEnv });
    // --ignore-unmatch: baseTree may not have subdir/ — that's fine, the
    // subsequent read-tree --prefix populates it from scratch.
    git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--", subdir], { env: idxEnv, safe: true });
    git(["read-tree", `--prefix=${subdir}/`, subtreeContent], { env: idxEnv });
    return git(["write-tree"], { env: idxEnv });
  });
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

/**
 * Compute the parent-tree base for a replayed commit by 3-way-merging all
 * mapped parents on the target side. For ancestor/descendant cases (e.g.
 * Bt1'_mono being an ancestor of Br2'_mono via a previous shadow-sync round)
 * `git merge-tree` reduces to a fast-forward — we get the descendant's tree,
 * which preserves outer state (frontend slice from a sibling pair's spliced
 * shadow merge) that the simple first-parent fallback would have dropped.
 *
 * For 3+ parents (no merge-tree) and for 2-parent conflicts, we check whether
 * the mapped parents agree on their **outer** slice (everything outside
 * `targetDir/`). The source commit can only have resolved content inside its
 * own repo — i.e. content that lands in `targetDir/` after replay — so if the
 * outer slices all match, splicing mappedParents[0]'s `targetDir/` over that
 * agreed outer is lossless: buildReplayedTree then applies the source diff on
 * top, carrying the user's in-repo merge resolution. If outer slices differ,
 * no auto-resolution is possible — fail loudly with a recipe the operator can
 * follow to manually reconcile (see formatUnresolvableMergeError).
 */
function mergeMappedParentTrees(opts: {
  mappedParents: string[];
  commitShort: string;
  targetDir: string;
}): string | null {
  const { mappedParents, commitShort, targetDir } = opts;

  if (mappedParents.length === 1) {
    const treeRes = git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true });
    if (!treeRes.ok || !treeRes.stdout) fail(`Cannot read tree of mapped parent ${mappedParents[0]} for ${commitShort}.`);
    return treeRes.stdout;
  }
  if (mappedParents.length === 2) {
    const mergeRes = git(["merge-tree", "--write-tree", mappedParents[0], mappedParents[1]], { safe: true });
    if (mergeRes.ok && /^[0-9a-f]{40}$/.test(mergeRes.stdout)) {
      return mergeRes.stdout;
    }
  }

  // Without a targetDir there's no outer/inner split — the source side has the
  // same file layout as target, so the source merge commit's diff already
  // carries the user's conflict resolution. Returning mappedParents[0]'s tree
  // lets buildReplayedTree apply that resolution on top.
  if (!targetDir) {
    const treeRes = git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true });
    if (!treeRes.ok || !treeRes.stdout) fail(`Cannot read tree of mapped parent ${mappedParents[0]} for ${commitShort}.`);
    return treeRes.stdout;
  }

  // Outer-agreement check: if every mapped parent has the same tree outside
  // targetDir/, splice mappedParents[0]'s targetDir/ over that shared outer.
  // The source merge's diff (applied later by buildReplayedTree) carries the
  // user's resolution for content inside targetDir/, so picking one parent's
  // inner here is fine — only the outer needs to be globally consistent.
  const outerTrees = mappedParents.map(p => outerOnlyTree(p, targetDir));
  if (outerTrees.every(t => t === outerTrees[0])) {
    const subdirRes = git(["rev-parse", `${mappedParents[0]}:${targetDir}`], { safe: true });
    return subdirRes.ok
      ? composeSubtree(outerTrees[0], targetDir, subdirRes.stdout)
      : outerTrees[0];
  }

  return null;
}

/**
 * Return the bare branch name on `sourceRemote` containing `commitHash` if
 * unambiguous, else null. Used to point error messages at the right shadow ref.
 */
function inferSourceBranch(commitHash: string, sourceRemote: string): string | null {
  const res = git(
    ["for-each-ref", "--format=%(refname:short)", "--contains", commitHash, `refs/remotes/${sourceRemote}/`],
    { safe: true },
  );
  if (!res.ok || !res.stdout) return null;
  const matches = res.stdout.split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(r => r.startsWith(`${sourceRemote}/`) ? r.slice(sourceRemote.length + 1) : r)
    .filter(b => b && b !== "HEAD");
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build the actionable error printed when mergeMappedParentTrees gives up.
 * The operator's escape: hand-write a target-side commit whose parents are the
 * divergent mapped parents and whose message carries the source→target trailer.
 * `loadReplayedMappings` will pick that up on the next run and treat the source
 * merge as already replayed, so the sync proceeds without re-attempting this.
 */
function formatUnresolvableMergeError(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  source: RepoEndpoint;
  target: RepoEndpoint;
  pair: SyncPair;
}): string {
  const { commit, meta, mappedParents, source, target, pair } = opts;
  const branchHint = inferSourceBranch(commit.hash, source.remote);
  const reason = mappedParents.length === 2
    ? `merge-tree conflict between mapped parents on ${target.remote}`
    : `octopus merge with ${mappedParents.length} mapped parents on ${target.remote} (no auto-resolution)`;
  const outerNote =
    `Mapped parents disagree on outer state (files outside ${target.dir}/). ` +
    `The source commit cannot have resolved this — outer files don't exist on ${source.remote}.`;
  const shadowRef = `refs/heads/${shadowBranchName(pair.name, branchHint ?? "<source-branch>")}`;
  const parentArgs = mappedParents.map(p => `-p ${p}`).join(" ");
  const ppLines = mappedParents.map(p => `    ${p}`).join("\n");
  const trailer = `${replayedTrailerKey(source.remote)}: ${commit.hash}`;

  const shortHash = commit.hash.slice(0, 7);
  return [
    `${meta.short}: cannot auto-resolve replay parent tree.`,
    ``,
    `  Source merge:   ${commit.hash}  (${meta.short})`,
    `  Failure:        ${reason}`,
    `  Mapped parents on ${target.remote}:`,
    ppLines,
    ``,
    `  ${outerNote}`,
    ``,
    `To reconcile manually, create a commit on ${shadowRef} that`,
    `  - has the divergent mapped parents above as its git parents`,
    `  - has a tree you choose (the resolved outer state + the merged inner state)`,
    `  - includes this trailer in its message body (exact text):`,
    ``,
    `      ${trailer}`,
    ``,
    `On the next sync run, ${meta.short} will be picked up via that trailer and skipped.`,
    ``,
    `  Suggested commands (run in this repo, with ${target.remote} fetched):`,
    `    git checkout -b manual-resolve-${shortHash} ${mappedParents[0]}`,
    `    git merge --no-ff ${mappedParents.slice(1).join(" ")}`,
    `    # resolve conflicts, stage the result, then:`,
    `    tree=$(git write-tree)`,
    `    new=$(git commit-tree $tree ${parentArgs} \\`,
    `        -m "Manual resolution of ${shortHash}" \\`,
    `        -m "${trailer}")`,
    `    git update-ref ${shadowRef} $new`,
    `    git push ${target.remote} ${shadowRef.replace(/^refs\/heads\//, "")}`,
    `  Then re-run shadow-sync.`,
  ].join("\n");
}

/** For parents outside the sync's scope, anchor to the newest replayed ancestor. */
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
  // Cross-pair shadow commits (e.g. shadow/frontend/<branch> on monorepo, when
  // we're syncing the BACKEND pair) carry a Shadow-replayed-<other-pair-remote>
  // trailer. They become reachable from this pair's working branches via the
  // mergeMappedParentTrees splice — once a sibling pair's outer state lands in
  // a shared shadow merge, those cross-pair commits show up in path-filtered
  // rev-list and would otherwise be replayed onto OUR pair's shadow as foreign
  // ancestry that doesn't fast-forward the existing tip. Drop them — the
  // underlying source-side commit (e.g. Mr1 for Mr1'_be) is itself in our
  // rev-list and will be replayed normally on our pair's shadow, with
  // mergeMappedParentTrees re-doing whatever sibling-echo outer splicing the
  // cross-pair shadow merge captured.
  const crossPairTrailerRe = new RegExp(`^${escapeRegex(REPLAYED_TRAILER)}-`, "m");
  return allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const meta = getCommitMeta(c.hash);
    if (hasTrailer(meta.trailers, dc.skipTrailerKey)) {
      const match = meta.trailers.split("\n")
        .map(l => l.match(dc.skipScanRe))
        .find(m => m);
      if (match && refExists(match[1])) {
        shaMapping.set(c.hash, match[1]);
      }
      return false;
    }
    if (crossPairTrailerRe.test(meta.trailers)) return false;
    return true;
  });
}

/**
 * Candidates whose replay would actually anchor a branch tip (Step 1) or be
 * needed to keep the parent chain of an anchoring replay intact (Step 2).
 *
 * Step 1 mirrors mapBranchesToTargetTips: linear topo-order walk newest-first
 * per branch, stopping at the first commit already in shaMapping. Any
 * candidate encountered before the stop is needed. Candidates skipped here
 * (e.g. `Mt2` in scenario.md, behind `Ft2'_mono`'s skip-trailer in topo-order)
 * are exactly the ones that would otherwise replay-then-orphan.
 *
 * Step 2: replays use mapped parents in resolveTargetParents — if an
 * anchoring candidate's source parent is also a candidate but NOT in step 1's
 * set, the replay would fall back to findEchoAnchor (different topology).
 * Walk parents of each needed candidate; if a parent is itself a candidate
 * and not yet mapped, include it. Stop at mapped or non-candidate parents.
 */
function collectNeededCandidates(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
  newCommits: TopoCommit[],
): Set<string> {
  const newSet = new Set(newCommits.map(c => c.hash));
  const needed = new Set<string>();

  for (const branch of branches) {
    const log = git(["rev-list", "--topo-order", `${remote}/${branch}`], { safe: true });
    if (!log.ok) fail(`rev-list ${remote}/${branch} failed while collecting needed candidates: ${log.stderr}`);
    for (const line of log.stdout.split("\n")) {
      const hash = line.trim();
      if (!hash) continue;
      if (shaMapping.has(hash)) break;
      if (newSet.has(hash)) needed.add(hash);
    }
  }

  const stack = Array.from(needed);
  while (stack.length) {
    const hash = stack.pop()!;
    const parentsRes = git(["log", "-1", "--format=%P", hash], { safe: true });
    if (!parentsRes.ok) fail(`log -1 --format=%P ${hash} failed: ${parentsRes.stderr}`);
    if (!parentsRes.stdout) continue; // root commit — no parents to chase
    for (const p of parentsRes.stdout.split(/\s+/).filter(Boolean)) {
      if (shaMapping.has(p)) continue;
      if (newSet.has(p) && !needed.has(p)) {
        needed.add(p);
        stack.push(p);
      }
    }
  }

  return needed;
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
    if (!log.ok) {
      fail(`Failed to list commits for ${remote}/${branch}: ${log.stderr}`);
    }
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
  pair: SyncPair;
}): void {
  const { newCommits, shaMapping, targetInit, source, target, dc, pair } = opts;
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-replay-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );

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
      let parentTree: string | null;
      if (composedParentTree) {
        parentTree = composedParentTree;
      } else if (mappedParents.length > 0) {
        const merged = mergeMappedParentTrees({ mappedParents, commitShort: meta.short, targetDir: target.dir });
        if (merged === null) {
          fail(formatUnresolvableMergeError({ commit, meta, mappedParents, source, target, pair }));
        }
        parentTree = merged;
      } else if (commit.parents.length === 0) {
        // Source root with no targetInit — buildReplayedTree handles null via read-tree --empty.
        parentTree = null;
      } else {
        fail(`Non-root commit ${meta.short} has no resolvable parent tree.`);
      }

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
}): { mirrored: number; branchMapping: Map<string, string>; shaMapping: Map<string, string>; upToDate: boolean } {
  const { pair, from, branches } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = buildDirectionConfig(source.remote, target.remote);

  console.log("Scanning history for already-replayed commits...");
  const shaMapping = loadReplayedMappings({ pair, target, branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  const allCommits = collectSourceCommits(source, branches);
  const newCommits = filterNotReplayedCommits(allCommits, shaMapping, dc);

  // Drop candidates that no branch's tip-walk would resolve to (and aren't
  // chain-needed by one that would). mapBranchesToTargetTips walks each branch
  // newest-first and stops at the first mapped ancestor, so a candidate
  // strictly older than every branch's anchor — and not on the parent chain
  // of an anchoring candidate — would replay-then-orphan (e.g. Mt2'_fe in the
  // scenario, where Ft2'_mono's skip-trailer halts the walk before Mt2).
  const needed = collectNeededCandidates(source.remote, branches, shaMapping, newCommits);
  const usefulNewCommits = newCommits.filter(c => needed.has(c.hash));

  if (usefulNewCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: mapBranchesToTargetTips(source.remote, branches, shaMapping),
      shaMapping,
      upToDate: true,
    };
  }

  console.log(`Found ${usefulNewCommits.length} new commit(s) to replay.\n`);

  // Fallback root for orphan parents (see resolveTargetParents).
  let targetInit: string | null = null;
  if (refExists(`${target.remote}/main`)) {
    const initRes = git(["rev-list", "--max-parents=0", `${target.remote}/main`], { safe: true });
    if (!initRes.ok) {
      fail(`Failed to find init commit on ${target.remote}/main: ${initRes.stderr}`);
    }
    targetInit = initRes.stdout.split("\n")[0] || null;
  }

  replayCommits({ newCommits: usefulNewCommits, shaMapping, targetInit, source, target, dc, pair });

  console.log();
  console.log(`Done. ${usefulNewCommits.length} commit(s) replayed.`);

  return {
    mirrored: usefulNewCommits.length,
    branchMapping: mapBranchesToTargetTips(source.remote, branches, shaMapping),
    shaMapping,
    upToDate: false,
  };
}

// ── Tag sync ──────────────────────────────────────────────────────────────────

/**
 * Source repo's tags are recreated on target, repointed at the replayed
 * commit. Annotated tags get a fresh tag object (same name, tagger, message;
 * new `object` line). Lightweight tags become `refs/tags/<name>` pointing
 * directly at the replay. Tags whose source commit was dropped (no entry in
 * shaMapping) are skipped — there's no target SHA to point at.
 */
export function syncTags(opts: {
  source: RepoEndpoint;
  target: RepoEndpoint;
  shaMapping: Map<string, string>;
}): { pushed: number; skipped: number } {
  const { source, target, shaMapping } = opts;

  // Make sure source-side tags are in our local object DB. Limit to source
  // remote so we don't pick up tags from the target side too.
  git(["fetch", source.remote, "--tags"], { safe: true });

  // List source-side tag refs. for-each-ref over refs/tags/* gives every tag
  // currently in the local repo; that's our source-of-truth after the fetch
  // above. We re-resolve each one against source.remote to make sure it's
  // actually a source-side tag (not a stray target-side one).
  const listRes = git(
    ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)"],
    { safe: true },
  );
  if (!listRes.ok || !listRes.stdout) return { pushed: 0, skipped: 0 };
  const tagLines = listRes.stdout.split("\n").filter(Boolean);
  if (tagLines.length === 0) return { pushed: 0, skipped: 0 };

  console.log(`\n── Syncing tags (${tagLines.length} candidate(s)) ──`);

  let pushed = 0;
  let skipped = 0;
  for (const line of tagLines) {
    const sep1 = line.indexOf("|");
    const sep2 = line.indexOf("|", sep1 + 1);
    const name = line.slice(0, sep1);
    const objectType = line.slice(sep1 + 1, sep2);

    // Peel to commit (works for both lightweight and annotated).
    const peeled = git(["rev-parse", `refs/tags/${name}^{commit}`], { safe: true });
    if (!peeled.ok) { skipped++; continue; }
    const sourceCommit = peeled.stdout;

    const targetCommit = shaMapping.get(sourceCommit);
    if (!targetCommit) {
      console.log(`  ${name}: source commit ${sourceCommit.slice(0, 8)} not replayed (skipping)`);
      skipped++;
      continue;
    }

    let pushSHA: string;
    if (objectType === "tag") {
      // Annotated: rebuild tag object with new commit-target.
      const tagBodyRes = git(["cat-file", "tag", `refs/tags/${name}`], { safe: true });
      if (!tagBodyRes.ok || !tagBodyRes.stdout) { skipped++; continue; }
      // cat-file gives us the body without a trailing newline; mktag is OK
      // with that, but be explicit. Replace the `object <sha>` header to
      // point at the replayed commit, then pipe through mktag.
      const newBody = tagBodyRes.stdout.replace(/^object [0-9a-f]+/m, `object ${targetCommit}`);
      const mktagRes = git(["mktag"], { input: newBody, safe: true });
      if (!mktagRes.ok || !mktagRes.stdout) {
        console.log(`  ${name}: mktag failed (${mktagRes.stderr.slice(0, 120)}), skipping`);
        skipped++;
        continue;
      }
      pushSHA = mktagRes.stdout;
    } else {
      pushSHA = targetCommit;
    }

    // Force-push: source is the source of truth for tags, so target may need
    // to overwrite a previous propagation if the source moved the tag.
    const pushRes = git(
      ["push", target.remote, `+${pushSHA}:refs/tags/${name}`],
      { safe: true },
    );
    if (!pushRes.ok) {
      console.log(`  ${name}: push failed (${pushRes.stderr.trim().slice(0, 120)}), skipping`);
      skipped++;
      continue;
    }
    console.log(`  ${name}${objectType === "tag" ? " (annotated)" : ""}: ${sourceCommit.slice(0, 8)} → ${targetCommit.slice(0, 8)} ✓`);
    pushed++;
  }

  console.log(`Tags: ${pushed} pushed, ${skipped} skipped.`);
  return { pushed, skipped };
}
