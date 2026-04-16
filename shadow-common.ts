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

export function preflightChecks(ref: string): { level: "error" | "warn"; code: string; message: string }[] {
  type W = { level: "error" | "warn"; code: string; message: string };
  const warnings: W[] = [];
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

export function handlePreflightResults(warnings: { level: "error" | "warn"; code: string; message: string }[]): boolean {
  for (const w of warnings) {
    console.error(`${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  }
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) console.error(`\nAborting due to ${errorCount} error(s).`);
  return errorCount === 0;
}

// ── Replay engine ─────────────────────────────────────────────────────────────

interface CommitMeta {
  hash:           string;
  authorName:     string;
  authorEmail:    string;
  authorDate:     string;
  committerName:  string;
  committerEmail: string;
  committerDate:  string;
  message:        string;
  trailers:       string;
  short:          string;
  parentCount:    number;
}

function getCommitMeta(hash: string): CommitMeta {
  const SEP = "---SHADOW-SEP---";
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%B", "%h: %s", "%P", "%(trailers:only,unfold=true)"]
    .join(SEP);
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split(SEP);
  const head = parts.slice(0, 6);
  const tail = parts.slice(-3);
  const message = parts.slice(6, -3).join(SEP);
  return {
    hash,
    authorName:     head[0],
    authorEmail:    head[1],
    authorDate:     head[2],
    committerName:  head[3],
    committerEmail: head[4],
    committerDate:  head[5],
    message,
    short:          tail[0],
    parentCount:    tail[1].split(/\s+/).filter(Boolean).length,
    trailers:       tail[2],
  };
}

function commitEnv(meta: CommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME:      meta.authorName,
    GIT_AUTHOR_EMAIL:     meta.authorEmail,
    GIT_AUTHOR_DATE:      meta.authorDate,
    GIT_COMMITTER_NAME:   meta.committerName,
    GIT_COMMITTER_EMAIL:  meta.committerEmail,
    GIT_COMMITTER_DATE:   meta.committerDate,
  };
}

function stripTrailers(message: string): string {
  const trailerPrefixes = [REPLAYED_TRAILER, SEED_TRAILER];
  return message.split("\n")
    .filter(l => !trailerPrefixes.some(t => l.startsWith(t)))
    .join("\n").trimEnd();
}

function sanitizeTokenPart(s: string): string {
  return s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function replayedTrailerKey(remote: string): string {
  return `${REPLAYED_TRAILER}-${sanitizeTokenPart(remote)}`;
}

/** Build a regex to match replay trailers: Shadow-replayed-{remote}: {hash} */
function replayedHashRe(remote: string): RegExp {
  const key = replayedTrailerKey(remote);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}:\\s*([0-9a-f]{7,40})`);
}

const SEED_HASH_RE = new RegExp(`^${SEED_TRAILER}:\\s*(\\S+)\\s+([0-9a-f]{7,40})`);

function findSeed(pairName: string): { seedHash: string; seedCommit: string } | null {
  const MARKER = "SEEDCOMMIT ";
  const log = git(
    ["log", "--all", `--grep=^${SEED_TRAILER}:`, `--format=${MARKER}%H%n%B`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return null;
  let currentCommit: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentCommit = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === pairName && currentCommit) {
      return { seedHash: match[2], seedCommit: currentCommit };
    }
  }
  return null;
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
  const MARKER = "TMAP ";
  const log = git([...logArgs, `--format=${MARKER}%H%n%B`], { safe: true });
  if (!log.ok || !log.stdout) return mapping;

  let currentHash: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentHash = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(trailerRe);
    if (match && currentHash) {
      mapping.set(match[1], currentHash);
    }
  }
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
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}:`, "m").test(trailers);
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
  shadowIgnorePatterns: string[];
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
    if (shadowIgnorePatterns.length > 0 && shadowIgnorePatterns.some(p => matchIgnorePattern(srcRelative, p))) {
      continue;
    }

    const targetPath = targetDir ? `${targetDir}/${srcRelative}` : srcRelative;

    if (status === "D") {
      git(["rm", "--cached", "-f", "--quiet", "--", targetPath], { env: idxEnv, safe: true });
    } else {
      git(["update-index", "--add", "--cacheinfo", `${newMode},${newHash},${targetPath}`], { env: idxEnv });
    }
  }

  return git(["write-tree"], { env: idxEnv });
}

/** Simple .shadowignore pattern matcher (supports * and ** globs). */
function matchIgnorePattern(filePath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "<<GLOBSTAR_SLASH>>")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR_SLASH>>/g, "(.*/)?")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath);
}

/** Collect commits from remote-tracking branches in topo order. */
function collectBranchCommits(
  refs: string[],
  seedHash?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedHash) args.push(`^${seedHash}`);
  args.push(...refs);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];
  return parseRevList(result.stdout);
}

/** Collect commits from branches, optionally filtered to those touching dir/. */
function collectCommitsForDir(
  refs: string[],
  dir: string,
  seedBoundary?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedBoundary) {
    // For remote refs use ^exclude, for branch ranges use seedBoundary..ref
    if (refs.length === 1 && !refs[0].includes("/")) {
      args.push(`${seedBoundary}..${refs[0]}`);
    } else {
      args.push(`^${seedBoundary}`, ...refs);
    }
  } else {
    args.push(...refs);
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
  scanRe:        RegExp;
  skipPrefix:    string;
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
    skipPrefix: replayedTrailerKey(targetRemote),
  };
}

/**
 * Build the source→target SHA mapping from existing replayed commits
 * on the target side. Prefers scanning the target's own shadow branches when
 * they exist; otherwise falls back to our local history (scoped to target.dir
 * when present).
 */
function scanReplayedMapping(opts: {
  pair: SyncPair;
  target: RepoEndpoint;
  branches: string[];
  dc: DirectionConfig;
}): Map<string, string> {
  const { pair, target, branches, dc } = opts;
  const shadowRefs = branches
    .map(b => `${target.remote}/${shadowBranchName(pair.name, b)}`)
    .filter(r => refExists(r));

  if (shadowRefs.length > 0) {
    return buildTrailerMapping(
      ["log", ...shadowRefs, `--grep=^${dc.addTrailerKey}`],
      dc.scanRe,
    );
  }
  const logArgs = ["log", "--all", `--grep=^${dc.addTrailerKey}`];
  if (target.dir) logArgs.push("--", `${target.dir}/`);
  return buildTrailerMapping(logArgs, dc.scanRe);
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
        ? ignoreContent.stdout.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
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
  const { pair, from, branches } = opts;
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const dc = directionConfig(source.remote, target.remote);

  // 1. Scan target history for already-replayed commits
  console.log("Scanning history for already-replayed commits...");
  const shaMapping = scanReplayedMapping({ pair, target, branches, dc });
  console.log(`Found ${shaMapping.size} previously replayed commit(s).`);

  // 2. Find seed
  const seed = findSeed(pair.name);
  if (seed) {
    console.log(`Found seed baseline: ${seed.seedHash.slice(0, 10)} (skipping earlier history).`);
  }

  // 3. Collect commits from source.
  const sourceRefs = opts.sourceBranch
    ? [source.url ? `${source.remote}/${opts.sourceBranch}` : opts.sourceBranch]
    : branches.map(b => `${source.remote}/${b}`);

  // Seed boundary: limits how far back we scan.
  let seedBoundary: string | undefined;
  if (seed) {
    const candidate = opts.sourceBranch ? seed.seedCommit : seed.seedHash;
    const ref = sourceRefs[0];
    if (git(["merge-base", "--is-ancestor", candidate, ref], { safe: true }).ok) {
      seedBoundary = candidate;
    }
    // No boundary = scan all commits on source (dedup handles the rest)
  }

  const allCommits = source.dir
    ? collectCommitsForDir(sourceRefs, source.dir, seedBoundary)
    : collectBranchCommits(sourceRefs, seedBoundary);

  // 4. Filter: skip already replayed + skip commits that came from the other side
  const newCommits = allCommits.filter(c => {
    if (shaMapping.has(c.hash)) return false;
    const meta = getCommitMeta(c.hash);
    if (hasTrailerLine(meta.trailers, dc.skipPrefix)) return false;
    return true;
  });

  if (newCommits.length === 0) {
    const branchMapping = opts.sourceBranch
      ? new Map<string, string>()
      : buildBranchMapping(source.remote, branches, shaMapping);
    return { mirrored: 0, branchMapping, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  // 5. Seed the SHA mapping so the first replayed commit chains naturally to the target's history (shared ancestry for `git merge`).
  if (seed) {
    shaMapping.set(seed.seedHash, seed.seedCommit);
    shaMapping.set(seed.seedCommit, seed.seedHash);
  }
  const fallbackParent = refExists(`${target.remote}/main`)
    ? git(["rev-parse", `${target.remote}/main`])
    : null;

  // 6. Replay loop — diff-based
  const { lastSHA } = runReplayLoop({
    newCommits, shaMapping, fallbackParent, source, target, dc,
  });

  // lastSHA can remain null if every commit in newCommits was skipped (buildRemappedTree returned null).
  const branchMapping: Map<string, string> = opts.sourceBranch
    ? (lastSHA ? new Map([[branches[0] ?? "main", lastSHA]]) : new Map())
    : buildBranchMapping(source.remote, branches, shaMapping);

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) replayed.`);

  return { mirrored: newCommits.length, branchMapping, upToDate: false };
}
