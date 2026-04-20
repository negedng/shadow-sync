import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  /** Git remote name */
  remote: string;
  /** URL for the repo. If absent, the remote must already exist. */
  url?: string;
  /** Path prefix in this repo ("backend", "" for root) */
  dir: string;
}

export interface SyncPair {
  /** Stable identifier — used in seed trailers and shadow branch names. */
  name: string;
  /** The two repo endpoints. Symmetric — direction is chosen at runtime via --from. */
  a: RepoEndpoint;
  b: RepoEndpoint;
}

interface ShadowSyncConfig {
  pairs: SyncPair[];
  trailers: { replayed: string; seed: string };
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
      trailers: { replayed: "Shadow-replayed", seed: "Shadow-seed" },
      gitConfigOverrides: {},
      maxBuffer: 50 * 1024 * 1024,
      shadowBranchPrefix: "shadow",
    };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;

  const trailers = {
    replayed: ((doc.trailers as Record<string, string>)?.replayed) ?? "Shadow-replayed",
    seed: ((doc.trailers as Record<string, string>)?.seed) ?? "Shadow-seed",
  };
  const gitConfigOverrides = (doc.gitConfigOverrides as Record<string, string>) ?? {};
  const maxBuffer = (doc.maxBuffer as number) ?? 50 * 1024 * 1024;
  const shadowBranchPrefix = (doc.shadowBranchPrefix as string) ?? "shadow";

  let pairs: SyncPair[];
  if (doc.pairs) {
    pairs = (doc.pairs as SyncPair[]);
  } else {
    pairs = [];
  }

  return { pairs, trailers, gitConfigOverrides, maxBuffer, shadowBranchPrefix };
}

const config = loadConfig();

export const PAIRS: SyncPair[] = [...config.pairs];
const REPLAYED_TRAILER = config.trailers.replayed;
export const SEED_TRAILER = config.trailers.seed;
let _shadowBranchPrefix = config.shadowBranchPrefix;
export { _shadowBranchPrefix as SHADOW_BRANCH_PREFIX };

// Allow tests to inject config via environment variable.
if (process.env.SHADOW_TEST_PAIRS) {
  PAIRS.length = 0;
  PAIRS.push(...JSON.parse(process.env.SHADOW_TEST_PAIRS));
}

// ── Core utilities ───────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;

/** Workspace root — ensures git commands use paths relative to the repo, not the cwd. */
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

export function getCurrentBranch(): string {
  const result = git(["symbolic-ref", "--short", "HEAD"], { safe: true });
  if (!result.ok) {
    die("You are in a detached HEAD state. Check out a branch first.");
  }
  return result.stdout;
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

/** Ensure a git remote is configured. If the endpoint has a url, add or update it. */
export function ensureRemote(endpoint: RepoEndpoint): void {
  if (!endpoint.url) return;
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
  const trailerPrefixes = [REPLAYED_TRAILER, SEED_TRAILER];
  return message.split("\n")
    .filter(l => !trailerPrefixes.some(t => l.startsWith(t)))
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

const SEED_HASH_RE = new RegExp(`^${SEED_TRAILER}:\\s*(\\S+)\\s+([0-9a-f]{7,40})`);

type Seed = { seedTrailerHash: string; seedCommitHash: string };

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

function findSeeds(pairName: string): Seed[] {
  const seeds: Seed[] = [];
  const seen = new Set<string>();
  scanLogCommits(["log", "--all", `--grep=^${SEED_TRAILER}:`], (hash, line) => {
    const match = line.match(SEED_HASH_RE);
    if (!match || match[1] !== pairName) return;
    const key = `${hash}:${match[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push({ seedTrailerHash: match[2], seedCommitHash: hash });
  });
  return seeds;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

interface TopoCommit {
  hash: string;
  parents: string[];
}

function parseRevList(output: string): TopoCommit[] {
  return output.split("\n").filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { hash: parts[0], parents: parts.slice(1) };
  });
}

function buildTrailerMapping(logArgs: string[], trailerRe: RegExp): Map<string, string> {
  const mapping = new Map<string, string>();
  scanLogCommits(logArgs, (hash, line) => {
    const match = line.match(trailerRe);
    if (match) mapping.set(match[1], hash);
  });
  return mapping;
}

function resolveParents(
  commit: TopoCommit,
  shaMapping: Map<string, string>,
  fallbackParent: string | null,
): string[] {
  // Per-parent fallback: an unmapped parent is replaced with fallbackParent rather than dropped to keep merge commit status
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const parentHash of commit.parents) {
    const mapped = shaMapping.get(parentHash) ?? fallbackParent;
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
 * Produce a new tree that equals `baseTree` with `subdir/` replaced by
 * `subtreeContent`. Used to keep shadow branches carrying the target side's
 * *current* non-pair content (not the seed-era snapshot the replay chain
 * would otherwise freeze).
 */
function spliceSubtree(baseTree: string, subdir: string, subtreeContent: string): string {
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-splice-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
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
 * For a branch on the source side that has no counterpart on the target side,
 * pick the existing source branch whose merge-base with `branch` is the most
 * recent — i.e., the branch `branch` was created from. Returns null if no
 * common ancestor is found (only true for truly unrelated histories).
 */
function findParentSourceBranch(
  sourceRemote: string,
  branch: string,
  allBranches: string[],
): string | null {
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const other of allBranches) {
    if (other === branch) continue;
    const otherRef = `${sourceRemote}/${other}`;
    if (!refExists(otherRef)) continue;
    const mb = git(["merge-base", `${sourceRemote}/${branch}`, otherRef], { safe: true });
    if (!mb.ok || !mb.stdout) continue;
    const tsRes = git(["log", "-1", "--format=%ct", mb.stdout], { safe: true });
    if (!tsRes.ok) continue;
    const ts = parseInt(tsRes.stdout, 10);
    if (!Number.isFinite(ts)) continue;
    if (ts > bestTime) {
      bestTime = ts;
      best = other;
    }
  }
  return best;
}

/**
 * Rewrite the replayed tip so its tree = target-side branch's current tree
 * with only `target.dir/` replaced by the replay's pair content. Preserves
 * the replay trailer + author/committer/message so downstream scans and
 * ancestry still work.
 *
 * Returns the original SHA unchanged when:
 *   - target.dir is empty (no non-pair content exists on target side),
 *   - no usable target-side tree can be found,
 *   - the composed tree already matches the replayed tree (no rewrite needed).
 *
 * Called once per branch at push time in `shadow-sync.ts`.
 */
export function composeShadowTip(opts: {
  target: RepoEndpoint;
  branch: string;
  replayedSHA: string;
  allSourceBranches: string[];
  sourceRemote: string;
}): string {
  const { target, branch, replayedSHA, allSourceBranches, sourceRemote } = opts;
  if (!target.dir) return replayedSHA;

  // 1. Pick the splice source tree.
  //    Precedence: target/<branch> → parent branch's target ref → target/main.
  const tryResolveTree = (ref: string): string | null => {
    if (!refExists(ref)) return null;
    return git(["rev-parse", `${ref}^{tree}`]);
  };
  let sliceSourceTree = tryResolveTree(`${target.remote}/${branch}`);
  if (!sliceSourceTree) {
    const parentBranch = findParentSourceBranch(sourceRemote, branch, allSourceBranches);
    if (parentBranch) {
      sliceSourceTree = tryResolveTree(`${target.remote}/${parentBranch}`);
    }
  }
  if (!sliceSourceTree) {
    sliceSourceTree = tryResolveTree(`${target.remote}/main`);
  }
  if (!sliceSourceTree) return replayedSHA;

  // 2. Extract the replayed tip's pair-scoped subtree.
  const pairSubtreeRes = git(["rev-parse", `${replayedSHA}:${target.dir}`], { safe: true });
  if (!pairSubtreeRes.ok) return replayedSHA;

  // 3. Splice and see whether anything would actually change.
  const composedTree = spliceSubtree(sliceSourceTree, target.dir, pairSubtreeRes.stdout);
  const replayedTree = git(["rev-parse", `${replayedSHA}^{tree}`]);
  if (composedTree === replayedTree) return replayedSHA;

  // 4. Re-commit with the composed tree, preserving parents and metadata.
  const meta = getCommitMeta(replayedSHA);
  const parentsStr = git(["log", "-1", "--format=%P", replayedSHA]);
  const parents = parentsStr.split(/\s+/).filter(Boolean);
  const parentArgs = parents.flatMap(p => ["-p", p]);
  return git(["commit-tree", composedTree, ...parentArgs, "-m", meta.message], {
    env: commitEnv(meta),
  });
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

/** Collect commits from remote-tracking branches in topo order. */
function collectBranchCommits(
  refs: string[],
  boundaries: string[] = [],
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  for (const b of boundaries) args.push(`^${b}`);
  args.push(...refs);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

type CommitSource =
  | { kind: "remoteRefs"; refs: string[] }
  | { kind: "localBranch"; branch: string };

/** Collect commits from branches, optionally filtered to those touching dir/. */
function collectCommitsForDir(
  source: CommitSource,
  dir: string,
  boundaries: string[] = [],
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  for (const b of boundaries) args.push(`^${b}`);
  if (source.kind === "localBranch") {
    args.push(source.branch);
  } else {
    args.push(...source.refs);
  }
  if (dir) args.push("--", `${dir}/`);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

function buildBranchMapping(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const headSHA = git(["rev-parse", `${remote}/${branch}`]);
    const replayedSHA = shaMapping.get(headSHA);
    if (replayedSHA) branchMapping.set(branch, replayedSHA);
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
 * to share the same source remote (e.g., both pairs sourcing from
 * `origin` in workspace mode).
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
 * Phase 6: walk newCommits in topo order, building each replayed tree by
 * diff-applying the source commit onto the previous tree, then committing
 * with the original author/committer identity and an added trailer.
 *
 * `shaMapping` is mutated: every replayed source hash is recorded so later
 * commits in the same batch can resolve their parents.
 */
function runReplayLoop(opts: {
  newCommits: TopoCommit[];
  shaMapping: Map<string, string>;
  fallbackParent: string | null;
  source: RepoEndpoint;
  target: RepoEndpoint;
  dc: DirectionConfig;
}): { lastSHA: string | null } {
  const { newCommits, shaMapping, fallbackParent, source, target, dc } = opts;
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-replay-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );

  let lastTree: string | null = null;
  let lastSHA: string | null = null;
  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);

      // Commits that carry the skip trailer came from the other direction
      // (e.g. forwarded by us then echoed back) — record but don't replay content
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

      const mappedParents = resolveParents(commit, shaMapping, fallbackParent);

      // Use the first mapped parent's tree as the base for this commit,
      // falling back to lastTree for linear history.
      const parentTree = mappedParents.length > 0
        ? git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true }).stdout || lastTree
        : lastTree;

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
      lastSHA = newSHA;
      console.log(isEcho ? "  ✓ Recorded." : "  ✓ Replayed.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  return { lastSHA };
}

/**
 * For each seed, pick whichever of its two hashes (commit or trailer) is
 * reachable from any of the given refs; use those as rev-list boundaries.
 * Multiple seeds produce multiple boundaries — each branch's pre-seed
 * history is excluded via its own reachable seed.
 */
function findSeedBoundaries(seeds: Seed[], refs: string[]): string[] {
  const boundaries: string[] = [];
  for (const seed of seeds) {
    for (const candidate of [seed.seedCommitHash, seed.seedTrailerHash]) {
      const reachable = refs.some(ref =>
        git(["merge-base", "--is-ancestor", candidate, ref], { safe: true }).ok,
      );
      if (reachable) {
        boundaries.push(candidate);
        break;
      }
    }
  }
  return boundaries;
}

/** Build source rev-list refs and collect candidate commits in topo order. */
function collectSourceCommits(opts: {
  source: RepoEndpoint;
  branches: string[];
  sourceBranch: string | undefined;
  seeds: Seed[];
}): TopoCommit[] {
  const { source, branches, sourceBranch, seeds } = opts;
  const useLocalBranch = !!sourceBranch && !source.url;
  const sourceRefs = sourceBranch
    ? [source.url ? `${source.remote}/${sourceBranch}` : sourceBranch]
    : branches.map(b => `${source.remote}/${b}`);
  const boundaries = findSeedBoundaries(seeds, sourceRefs);

  return source.dir
    ? collectCommitsForDir(
        useLocalBranch
          ? { kind: "localBranch", branch: sourceBranch! }
          : { kind: "remoteRefs", refs: sourceRefs },
        source.dir,
        boundaries,
      )
    : collectBranchCommits(sourceRefs, boundaries);
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

/** Pre-seed both directions of the SHA map so the first replayed commit chains to the target's history. */
function seedShaMapping(shaMapping: Map<string, string>, seeds: Seed[]): void {
  for (const seed of seeds) {
    shaMapping.set(seed.seedTrailerHash, seed.seedCommitHash);
    shaMapping.set(seed.seedCommitHash, seed.seedTrailerHash);
  }
}

/**
 * Replay commits from one side of a pair to the other.
 *
 * @param from - "a" or "b": which side's commits to replay
 * @param branches - branches to replay (remote-tracking refs for the source)
 * @param sourceBranch - when replaying from a workspace branch (not remote refs),
 *                       the branch name to collect commits from
 */
export function replayCommits(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
  sourceBranch?: string;
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { pair, from, branches, sourceBranch } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = directionConfig(source.remote, target.remote);

  console.log("Scanning history for already-replayed commits...");
  const shaMapping = scanReplayedMapping({ pair, target, branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  const seeds = findSeeds(pair.name);
  if (seeds.length > 0) {
    const summary = seeds.map(s => s.seedTrailerHash.slice(0, 10)).join(", ");
    console.log(`Found ${seeds.length} seed baseline(s): ${summary} (skipping earlier history).`);
  }

  const allCommits = collectSourceCommits({ source, branches, sourceBranch, seeds });
  const newCommits = filterNewCommits(allCommits, shaMapping, dc);

  if (newCommits.length === 0) {
    const branchMapping = sourceBranch
      ? new Map<string, string>()
      : buildBranchMapping(source.remote, branches, shaMapping);
    return { mirrored: 0, branchMapping, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  if (seeds.length > 0) seedShaMapping(shaMapping, seeds);
  const fallbackParent = refExists(`${target.remote}/main`)
    ? git(["rev-parse", `${target.remote}/main`])
    : null;

  const { lastSHA } = runReplayLoop({
    newCommits, shaMapping, fallbackParent, source, target, dc,
  });

  // lastSHA can remain null if every commit in newCommits was skipped (buildRemappedTree returned null).
  const branchMapping: Map<string, string> = sourceBranch
    ? (lastSHA ? new Map([[branches[0] ?? "main", lastSHA]]) : new Map())
    : buildBranchMapping(source.remote, branches, shaMapping);

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) replayed.`);

  return { mirrored: newCommits.length, branchMapping, upToDate: false };
}
