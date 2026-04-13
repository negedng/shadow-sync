import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

interface RemoteConfig {
  /** Git remote name — must match `git remote add <name> <url>` */
  remote: string;
  /** Local subdirectory in your repo that maps to the root of that remote */
  dir: string;
  /** URL for the external repo */
  url: string;
}

interface ShadowSyncConfig {
  remotes: RemoteConfig[];
  trailers: { sync: string; seed: string; forward: string; exp: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  maxDirDepth: number;
  shadowBranchPrefix: string;
}

const CONFIG_PATH = path.join(__dirname, "shadow-config.json");

function loadConfig(): ShadowSyncConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const doc = JSON.parse(raw) as Record<string, unknown>;
  return {
    remotes:           (doc.remotes as RemoteConfig[]) ?? [],
    trailers: {
      sync: ((doc.trailers as Record<string, string>)?.sync) ?? "Shadow-synced-from",
      seed: ((doc.trailers as Record<string, string>)?.seed) ?? "Shadow-seed",
      forward: ((doc.trailers as Record<string, string>)?.forward) ?? "Shadow-forwarded-from",
      exp: ((doc.trailers as Record<string, string>)?.export) ?? "Shadow-export",
    },
    gitConfigOverrides: (doc.gitConfigOverrides as Record<string, string>) ?? {},
    maxBuffer:          (doc.maxBuffer as number) ?? 50 * 1024 * 1024,
    maxDirDepth:        (doc.maxDirDepth as number) ?? 100,
    shadowBranchPrefix: (doc.shadowBranchPrefix as string) ?? "shadow",
  };
}

const config = loadConfig();

export const REMOTES: RemoteConfig[] = [...config.remotes];
const SYNC_TRAILER    = config.trailers.sync;
export const SEED_TRAILER    = config.trailers.seed;
export const FORWARD_TRAILER = config.trailers.forward;
export const EXPORT_TRAILER  = config.trailers.exp;
export const SHADOW_BRANCH_PREFIX = config.shadowBranchPrefix;

// Allow tests to inject config via environment variable (JSON array of RemoteConfig).
if (process.env.SHADOW_TEST_REMOTES) {
  REMOTES.length = 0;
  REMOTES.push(...JSON.parse(process.env.SHADOW_TEST_REMOTES));
}

// ── Core utilities ───────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Repo root — ensures git commands use paths relative to the repo, not the cwd.
 *  When invoked via `npm --prefix shadow`, cwd is shadow/ which breaks path-based commands. */
const REPO_ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" })
  .stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

export function die(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

/** Validate that a dir/remote name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) die(`${label} must not be empty.`);
  if (value.includes("..")) die(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) die(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) die(`${label} must not start with '-'.`);
}

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

/** Run a git command. Throws on non-zero exit.
 *  Use { plain: true } to skip config overrides (for working-tree ops on Windows).
 *  Use { raw: true } to skip trimming stdout (for patches where whitespace matters). */
export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
/** Run a git command. Returns { stdout, stderr, status, ok } — never throws.
 *  Use { plain: true } to skip config overrides (for working-tree ops on Windows). */
export function git(args: string[], opts: GitOpts & { safe: true }): GitResult;
export function git(args: string[], opts?: GitOpts & { safe?: boolean }): string | GitResult {
  const fullArgs = opts?.plain ? args : [...GIT_CONFIG_OVERRIDES, ...args];
  const r = spawnSync("git", fullArgs, {
    encoding: "utf8", cwd: opts?.cwd ?? REPO_ROOT, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
    ...(opts?.input != null ? { input: opts.input } : {}),
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });

  const trim = (s: string) => opts?.raw ? s : s.trim();

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

export function listExternalBranches(remote: string): string[] {
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

/** Build the canonical shadow branch name: shadow/{dir}/{branch} */
export function shadowBranchName(dir: string, branch: string): string {
  return `${SHADOW_BRANCH_PREFIX}/${dir}/${branch}`;
}

/** Append a trailer to a commit message using `git interpret-trailers`. */
export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

// ── Lockfile ──────────────────────────────────────────────────────────────────

/**
 * Prevent concurrent runs of the same script by creating a PID-based lock file
 * in the OS temp directory. If a stale lock exists (process no longer alive),
 * it is removed automatically. The lock is released on exit, SIGINT, or SIGTERM.
 * Uses exclusive file creation (wx flag) to avoid races between the existence
 * check and lock acquisition.
 */
export function acquireLock(scriptDir: string, name: string): void {
  const key   = crypto.createHash("md5").update(scriptDir).digest("hex").slice(0, 8);
  const lock  = path.join(os.tmpdir(), `${name}-${key}.lock`);
  const myPid = process.pid.toString();

  if (fs.existsSync(lock)) {
    const existingPid = fs.readFileSync(lock, "utf8").trim();
    let alive = false;
    if (/^\d+$/.test(existingPid)) {
      if (process.platform === "win32") {
        const r = spawnSync("tasklist", ["/FI", `PID eq ${existingPid}`, "/NH"], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        alive = (r.stdout ?? "").includes(existingPid);
      } else {
        const r = spawnSync("kill", ["-0", existingPid], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        alive = r.status === 0;
      }
    }
    if (alive) die(`Another ${name} is already running (PID ${existingPid}).`);
    try { fs.unlinkSync(lock); } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  try {
    fs.writeFileSync(lock, myPid, { flag: "wx" });
  } catch (e: any) {
    if (e.code === "EEXIST") {
      die(`Another ${name} is already running (lock file appeared during race).`);
    }
    throw e;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8").trim() === myPid) {
        fs.unlinkSync(lock);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") console.warn(`Warning: failed to release lock: ${e.message}`);
    }
  };

  process.on("exit",    release);
  process.on("SIGINT",  () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

/**
 * Run pre-flight checks on an external ref before syncing.
 * Inspects the remote's tree for potential issues: shallow clones (need full
 * history for commit replay), submodules (can't be synced), symlinks (targets
 * won't be adjusted for the subdirectory), case-conflicting paths (data loss
 * on Windows/macOS), and Git LFS usage (only pointer files are transferred).
 * Returns an array of warnings/errors. Callers should abort on "error" level.
 */
export function preflightChecks(externalRef: string): { level: "error" | "warn"; code: string; message: string }[] {
  type W = { level: "error" | "warn"; code: string; message: string };
  const warnings: W[] = [];
  const warn  = (code: string, message: string) => warnings.push({ level: "warn", code, message });
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  const tree = git(["ls-tree", "-r", "--long", externalRef], { safe: true });
  if (tree.ok && tree.stdout) {
    const paths: string[] = [];
    for (const entry of tree.stdout.split("\n").filter(Boolean)) {
      const m = entry.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\s+[\d-]+\t(.+)$/);
      if (!m) continue;
      const [, mode, , filePath] = m;
      paths.push(filePath);
      if (mode === "160000") warn("SUBMODULE", `Remote contains a submodule at '${filePath}'. Submodules cannot be synced and will be skipped.`);
      if (mode === "120000") warn("SYMLINK", `Remote contains a symlink at '${filePath}'. Symlink targets are not adjusted for the local subdirectory.`);
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

  const attrs = git(["show", `${externalRef}:.gitattributes`], { safe: true });
  if (attrs.ok && attrs.stdout.includes("filter=lfs")) {
    warn("GIT_LFS", "Remote uses Git LFS. Shadow sync will transfer LFS pointer files, not actual content.\n  Ensure LFS is configured in the internal repo, or large files will be pointers.");
  }

  return warnings;
}

/**
 * Print preflight warnings and abort on errors.
 * Returns true if safe to continue, false if there were errors.
 */
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
  short:          string;
  parentCount:    number;
}

function getCommitMeta(hash: string): CommitMeta {
  const SEP = "---SHADOW-SEP---";
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%B", "%h: %s", "%P"]
    .join(SEP);
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split(SEP);
  const head = parts.slice(0, 6);
  const tail = parts.slice(-2);
  const message = parts.slice(6, -2).join(SEP);
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
  };
}

function diffForCommit(meta: CommitMeta): string {
  const { hash, parentCount } = meta;
  const diffArgs = ["-c", "core.filemode=false",
    "diff", "--binary", "-M", "--no-ext-diff", "--no-textconv"];
  if (parentCount === 0) {
    return git([...diffArgs, EMPTY_TREE, hash], { raw: true });
  }
  const parentHash = git(["rev-parse", `${hash}^1`]);
  return git([...diffArgs, parentHash, hash], { raw: true });
}

function commitWithMeta(meta: CommitMeta, message: string, allowEmpty = false): void {
  git(["commit", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message], {
    env: {
      GIT_AUTHOR_NAME:      meta.authorName,
      GIT_AUTHOR_EMAIL:     meta.authorEmail,
      GIT_AUTHOR_DATE:      meta.authorDate,
      GIT_COMMITTER_NAME:   meta.committerName,
      GIT_COMMITTER_EMAIL:  meta.committerEmail,
      GIT_COMMITTER_DATE:   meta.committerDate,
    },
  });
}

function filesForCommit(meta: CommitMeta, subdir: string): string[] {
  const { hash, parentCount } = meta;
  const nameArgs = ["-c", "core.filemode=false",
    "diff", "--name-only", "-M", "--no-ext-diff", "--no-textconv"];
  const raw = parentCount === 0
    ? git([...nameArgs, EMPTY_TREE, hash])
    : git([...nameArgs, `${hash}^1`, hash]);
  return raw.split("\n").filter(Boolean).map(f => `${subdir}/${f}`);
}

const SYNCED_HASH_RE = new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`);

function buildAlreadySyncedSetFor(dir: string, seedHash?: string): Set<string> {
  const synced = new Set<string>();
  const log = git(
    ["log", `--grep=^${SYNC_TRAILER}:`, "--format=%B",
     ...(seedHash ? [`${seedHash}..HEAD`] : []),
     "--", `${dir}/`], { safe: true }
  );
  if (!log.ok || !log.stdout) return synced;

  for (const line of log.stdout.split("\n")) {
    const match = line.match(SYNCED_HASH_RE);
    if (match) synced.add(match[1]);
  }
  return synced;
}

const SEED_HASH_RE = new RegExp(`^${SEED_TRAILER}:\\s*(\\S+)\\s+([0-9a-f]{7,40})`);

function findSeedHash(dir: string): string | null {
  const log = git(["log", "--all", `--grep=^${SEED_TRAILER}:`, "--format=%B"], { safe: true });
  if (!log.ok || !log.stdout) return null;
  for (const line of log.stdout.split("\n")) {
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir) return match[2];
  }
  return null;
}

/** Returns the local commit SHA of the seed commit for a directory. */
function findSeedCommit(dir: string): string | null {
  const MARKER = "SEEDCOMMIT ";
  const log = git(
    ["log", "--all", `--grep=^${SEED_TRAILER}:`, `--format=${MARKER}%H%n%B`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return null;
  let currentLocal: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentLocal = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir && currentLocal) return currentLocal;
  }
  return null;
}

function collectExternalCommits(
  externalRef: string,
  seedHash?: string,
): string[] {
  const args = ["log", "--reverse", "--format=%H"];
  if (seedHash) {
    args.push(`${seedHash}..${externalRef}`);
  } else {
    args.push(externalRef);
  }
  const commits = git(args, { safe: true });
  if (!commits.ok || !commits.stdout) return [];
  return commits.stdout.split("\n").filter(Boolean);
}

/**
 * Replay new commits from a remote ref into a local subdirectory.
 *
 * Assumes the caller has already:
 *   1. Fetched the remote
 *   2. Checked out the correct local branch
 *
 * Throws on unrecoverable errors instead of calling process.exit().
 */
export function replayCommits(opts: {
  remote: string;
  dir: string;
  externalBranch: string;
}): { mirrored: number; upToDate: boolean } {
  const { remote, dir, externalBranch } = opts;
  const externalRef = `${remote}/${externalBranch}`;

  // A seed marks the starting point for sync — all commits before it are skipped.
  const seedHash = findSeedHash(dir);
  if (seedHash) {
    console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
  }

  // Scans local git log for Shadow-synced-from trailers to avoid re-replaying commits.
  // When a seed exists, only scan commits after it.
  console.log("Scanning local history for already-mirrored commits...");
  const alreadySynced = buildAlreadySyncedSetFor(dir, seedHash ?? undefined);
  console.log(`Found ${alreadySynced.size} previously mirrored commit(s).`);

  // Collect new commits to replay
  const allExternalCommits = collectExternalCommits(externalRef, seedHash ?? undefined);

  const newCommits: string[] = [];
  for (const hash of allExternalCommits) {
    if (alreadySynced.has(hash)) continue;
    newCommits.push(hash);
  }

  if (newCommits.length === 0) {
    console.log("Already up to date. Nothing to mirror.");
    return { mirrored: 0, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to mirror.\n`);

  // Replay each commit
  for (const hash of newCommits) {
    const meta = getCommitMeta(hash);

    // Skip commits that were forwarded by us (they have a forward trailer).
    if (meta.message.includes(`${FORWARD_TRAILER}:`)) {
      console.log(`  Skipping ${meta.short} (forwarded by us).`);
      alreadySynced.add(hash);
      const trailerPrefixes = [SYNC_TRAILER, SEED_TRAILER, FORWARD_TRAILER, EXPORT_TRAILER];
      const cleanMsg = meta.message.split("\n").filter(l => !trailerPrefixes.some(t => l.startsWith(`${t}:`))).join("\n").trimEnd();
      const syncedMessage = appendTrailer(cleanMsg, `${SYNC_TRAILER}: ${hash}`);
      commitWithMeta(meta, syncedMessage, true);
      continue;
    }

    const label = meta.parentCount > 1
      ? `merge commit ${meta.short} (diffing against first parent)`
      : meta.parentCount === 0
        ? `root commit ${meta.short}`
        : meta.short;

    console.log(`  Applying ${label}...`);

    // Generate a diff for this commit and apply it under the subdirectory.
    // The patch maps external repo root paths into {dir}/ in the monorepo.
    const patch = diffForCommit(meta);
    // Apply patch via stdin, normalizing CRLF → LF for cross-OS consistency
    const result = git(["apply", "--directory", dir, "--ignore-whitespace"],
      { safe: true, input: patch.replace(/\r\n/g, "\n") }).ok;

    if (!result) {
      throw new Error(`Could not apply patch for ${meta.short}. Shadow branch may be out of sync.`);
    }

    // Stage only the files touched by this patch (not the whole dir).
    const patchFiles = filesForCommit(meta, dir);
    if (patchFiles.length > 0) {
      git(["add", "--", ...patchFiles]);
    }

    // Commit with the original author/committer metadata preserved, plus a
    // sync trailer recording the external commit hash for deduplication.
    const hasStagedChanges = !git(["diff", "--cached", "--quiet"], { safe: true }).ok;
    const syncedMessage    = appendTrailer(meta.message, `${SYNC_TRAILER}: ${hash}`);

    // If the patch produced no actual changes (e.g. the file was already
    // identical), record an empty commit so we skip it on future runs.
    if (!hasStagedChanges) {
      console.log("    (no changes after apply — recording as synced)");
      commitWithMeta(meta, syncedMessage, /* allowEmpty */ true);
      console.log("  ✓ Recorded (empty).");
      continue;
    }

    commitWithMeta(meta, syncedMessage);
    console.log("  ✓ Mirrored.");
  }

  console.log();
  console.log(
    `Done. ${newCommits.length} commit(s) from '${remote}/${externalBranch}' mirrored into '${dir}/' on current branch.`
  );

  return { mirrored: newCommits.length, upToDate: false };
}

// ── Topology-preserving replay engine ────────────────────────────────────────

interface TopoCommit {
  hash: string;
  parents: string[];
}

/**
 * Build a mapping of external SHA → local SHA from existing synced commits.
 * Scans ALL branches (--all) so the mapping is global across shadow branches.
 */
function buildSyncedMapping(dir: string): Map<string, string> {
  const mapping = new Map<string, string>();
  const MARKER = "SHADOWMAP ";
  const log = git(
    ["log", "--all", `--grep=^${SYNC_TRAILER}:`, `--format=${MARKER}%H%n%B`, "--", `${dir}/`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return mapping;

  let currentLocal: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentLocal = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(SYNCED_HASH_RE);
    if (match && currentLocal) {
      mapping.set(match[1], currentLocal);
    }
  }
  return mapping;
}

/**
 * Collect all commits across multiple branches in topological order (parents first).
 * Uses `git rev-list --topo-order --reverse --parents` for a single traversal
 * that automatically deduplicates shared commits.
 */
function collectAllExternalCommits(
  remote: string,
  branches: string[],
  seedHash?: string,
): TopoCommit[] {
  const refs = branches.map(b => `${remote}/${b}`);
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedHash) {
    args.push(`^${seedHash}`);
  }
  args.push(...refs);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];

  return result.stdout.split("\n").filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { hash: parts[0], parents: parts.slice(1) };
  });
}

/**
 * Map each branch name to the local SHA corresponding to its external HEAD.
 */
function buildBranchMapping(
  remote: string,
  branches: string[],
  shaMapping: Map<string, string>,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const headSHA = git(["rev-parse", `${remote}/${branch}`]);
    const localSHA = shaMapping.get(headSHA);
    if (localSHA) branchMapping.set(branch, localSHA);
  }
  return branchMapping;
}

/**
 * Replay commits from multiple external branches into a local subdirectory,
 * preserving the original DAG topology (shared ancestors stay shared).
 *
 * Instead of checking out branches and cherry-picking, this uses git plumbing:
 *   - `git read-tree --prefix` to scope external trees under {dir}/
 *   - `git commit-tree` to create commits with explicit parents
 *   - `git update-ref` (by caller) to point shadow branches at the right tips
 *
 * Returns a branchMapping so the caller can update each shadow branch ref.
 */
export function replayCommitsTopological(opts: {
  remote: string;
  dir: string;
  branches: string[];
}): { mirrored: number; branchMapping: Map<string, string>; upToDate: boolean } {
  const { remote, dir, branches } = opts;

  console.log("Scanning local history for already-mirrored commits...");
  const shaMapping = buildSyncedMapping(dir);
  console.log(`Found ${shaMapping.size} previously mirrored commit(s).`);

  const seedHash = findSeedHash(dir);
  if (seedHash) {
    console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
  }

  const allCommits = collectAllExternalCommits(remote, branches, seedHash ?? undefined);
  const newCommits = allCommits.filter(c => !shaMapping.has(c.hash));

  if (newCommits.length === 0) {
    const branchMapping = buildBranchMapping(remote, branches, shaMapping);
    return { mirrored: 0, branchMapping, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to mirror.\n`);

  // Use the seed commit as graft base — it's on main's history, so shadow
  // branches share ancestry with main and can be merged with plain `git merge`.
  const graftBase = findSeedCommit(dir);
  if (graftBase) {
    console.log(`Using seed commit ${graftBase.slice(0, 10)} as graft base (shared ancestry with main).`);
  }

  const tmpIndex = path.join(os.tmpdir(), `shadow-topo-idx-${Date.now()}`);

  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);
      const isForwarded = meta.message.includes(`${FORWARD_TRAILER}:`);

      if (isForwarded) {
        console.log(`  Skipping ${meta.short} (forwarded by us).`);
      } else {
        const label = commit.parents.length > 1
          ? `merge commit ${meta.short}`
          : commit.parents.length === 0
            ? `root commit ${meta.short}`
            : meta.short;
        console.log(`  Applying ${label}...`);
      }

      // Map external parents → local parents (must happen before tree construction)
      const localParents: string[] = [];
      for (const parentHash of commit.parents) {
        const localParent = shaMapping.get(parentHash);
        if (localParent) {
          localParents.push(localParent);
        }
      }

      // Graft root commits (no mapped parents) onto seed commit
      if (localParents.length === 0 && graftBase) {
        localParents.push(graftBase);
      }

      // Build full-repo tree: start from parent's tree, overlay dir/ from external.
      // This ensures shadow commits carry the full repo tree (not just dir/),
      // so merging the shadow branch into main doesn't delete other files.
      const baseTree = localParents.length > 0
        ? `${localParents[0]}^{tree}`
        : graftBase ? `${graftBase}^{tree}` : null;

      if (baseTree) {
        git(["read-tree", baseTree], { env: { GIT_INDEX_FILE: tmpIndex } });
        // Remove old dir/ content, then overlay new external content
        git(["rm", "-r", "--cached", "--quiet", `${dir}/`], { env: { GIT_INDEX_FILE: tmpIndex }, safe: true });
        git(["read-tree", `--prefix=${dir}/`, `${commit.hash}^{tree}`], { env: { GIT_INDEX_FILE: tmpIndex } });
      } else {
        // No base tree available — fall back to dir/-only tree (orphan)
        git(["read-tree", "--empty"], { env: { GIT_INDEX_FILE: tmpIndex } });
        git(["read-tree", `--prefix=${dir}/`, `${commit.hash}^{tree}`], { env: { GIT_INDEX_FILE: tmpIndex } });
      }
      const tree = git(["write-tree"], { env: { GIT_INDEX_FILE: tmpIndex } });

      // Build commit message with sync trailer
      let message: string;
      if (isForwarded) {
        const cleanMsg = meta.message.split("\n").filter(l => !l.match(/^Shadow-/)).join("\n").trimEnd();
        message = appendTrailer(cleanMsg, `${SYNC_TRAILER}: ${commit.hash}`);
      } else {
        message = appendTrailer(meta.message, `${SYNC_TRAILER}: ${commit.hash}`);
      }

      // Create commit with explicit parents via git plumbing
      const parentArgs = localParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", message], {
        env: {
          GIT_AUTHOR_NAME:      meta.authorName,
          GIT_AUTHOR_EMAIL:     meta.authorEmail,
          GIT_AUTHOR_DATE:      meta.authorDate,
          GIT_COMMITTER_NAME:   meta.committerName,
          GIT_COMMITTER_EMAIL:  meta.committerEmail,
          GIT_COMMITTER_DATE:   meta.committerDate,
        },
      });

      shaMapping.set(commit.hash, newSHA);
      console.log(isForwarded ? "  ✓ Recorded." : "  ✓ Mirrored.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  const branchMapping = buildBranchMapping(remote, branches, shaMapping);

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) mirrored with preserved topology.`);

  return { mirrored: newCommits.length, branchMapping, upToDate: false };
}

// ── Reverse replay (export direction) ────────────────────────────────────────

const FORWARD_HASH_RE = new RegExp(`^${FORWARD_TRAILER}:\\s*([0-9a-f]{7,40})`);

/**
 * Build a mapping of local SHA → external SHA from commits on the external
 * remote that have a Shadow-forwarded-from trailer.
 */
function buildForwardedMapping(remote: string, branches: string[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const MARKER = "FWDMAP ";
  const refs = branches.map(b => `${remote}/${b}`).filter(r => refExists(r));
  if (refs.length === 0) return mapping;

  const log = git(
    ["log", ...refs, `--grep=^${FORWARD_TRAILER}:`, `--format=${MARKER}%H%n%B`],
    { safe: true },
  );
  if (!log.ok || !log.stdout) return mapping;

  let currentExternal: string | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith(MARKER)) {
      currentExternal = line.slice(MARKER.length).trim();
      continue;
    }
    const match = line.match(FORWARD_HASH_RE);
    if (match && currentExternal) {
      mapping.set(match[1], currentExternal);  // local SHA → external SHA
    }
  }
  return mapping;
}

/**
 * Collect local commits that touch dir/ in topological order.
 * Uses git rev-list on the local branch, filtering to commits that touch dir/.
 */
function collectLocalCommitsForDir(
  dir: string,
  branch: string,
  seedCommit?: string,
): TopoCommit[] {
  const args = ["rev-list", "--topo-order", "--reverse", "--parents"];
  if (seedCommit) {
    args.push(`${seedCommit}..${branch}`);
  } else {
    args.push(branch);
  }
  // Only commits that touch dir/
  args.push("--", `${dir}/`);

  const result = git(args, { safe: true });
  if (!result.ok || !result.stdout) return [];

  return result.stdout.split("\n").filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { hash: parts[0], parents: parts.slice(1) };
  });
}

/**
 * Replay local commits to an external remote, stripping the dir/ prefix.
 * This is the reverse of replayCommitsTopological — instead of adding a prefix,
 * we strip it. The result is pushed to a shadow branch on the external repo
 * so the external team can `git merge` to pull in changes.
 *
 * Uses git plumbing:
 *   - `git read-tree <commit>:{dir}` to strip the prefix (reads subtree at root)
 *   - `git commit-tree` to create commits with explicit parents
 *
 * Skips commits that have a SYNC_TRAILER (they came from external, no echo-back).
 */
export function replayCommitsToExternal(opts: {
  remote: string;
  dir: string;
  localBranch: string;
  externalBranch: string;
  shadowIgnoreFile?: string;
}): { mirrored: number; tipSHA: string | null; upToDate: boolean } {
  const { remote, dir, localBranch, externalBranch } = opts;

  // The external shadow branch where we push stripped commits.
  // Convention: shadow/{localBranchName} on the external repo.
  const extShadowBranch = `${SHADOW_BRANCH_PREFIX}/${externalBranch}`;

  console.log("Scanning external history for already-forwarded commits...");
  const shaMapping = buildForwardedMapping(remote, [extShadowBranch]);
  console.log(`Found ${shaMapping.size} previously forwarded commit(s).`);

  // Find the seed commit (on local main) and the seed hash (external tip at seed time)
  const seedCommit = findSeedCommit(dir);
  const seedHash = findSeedHash(dir);
  if (seedCommit) {
    console.log(`Found seed commit: ${seedCommit.slice(0, 10)}`);
  }

  // Collect local commits that touch dir/ since the seed
  const allCommits = collectLocalCommitsForDir(dir, localBranch, seedCommit ?? undefined);
  const newCommits = allCommits.filter(c => {
    // Skip already forwarded
    if (shaMapping.has(c.hash)) return false;
    // Skip commits that came from external (have sync trailer)
    const meta = getCommitMeta(c.hash);
    if (meta.message.includes(`${SYNC_TRAILER}:`)) return false;
    return true;
  });

  if (newCommits.length === 0) {
    return { mirrored: 0, tipSHA: null, upToDate: true };
  }

  console.log(`Found ${newCommits.length} new commit(s) to forward.\n`);

  // Graft base: the external commit that the seed points to.
  // This gives the external shadow branch shared ancestry with the external main.
  const graftBase = seedHash ?? null;
  if (graftBase) {
    console.log(`Using external seed ${graftBase.slice(0, 10)} as graft base.`);
  }

  const tmpIndex = path.join(os.tmpdir(), `shadow-fwd-idx-${Date.now()}`);

  let lastSHA: string | null = null;
  try {
    for (const commit of newCommits) {
      const meta = getCommitMeta(commit.hash);
      const label = commit.parents.length > 1
        ? `merge commit ${meta.short}`
        : meta.short;
      console.log(`  Forwarding ${label}...`);

      // Build stripped tree: read dir/ subtree at root level
      const dirTree = git(["rev-parse", `${commit.hash}:${dir}`], { safe: true });
      if (!dirTree.ok) {
        console.log(`  Skipping ${meta.short} (no ${dir}/ content).`);
        continue;
      }
      git(["read-tree", "--empty"], { env: { GIT_INDEX_FILE: tmpIndex } });
      git(["read-tree", dirTree.stdout], { env: { GIT_INDEX_FILE: tmpIndex } });

      // Apply .shadowignore if provided
      if (opts.shadowIgnoreFile && fs.existsSync(opts.shadowIgnoreFile)) {
        const ignored = git(
          ["ls-files", "--cached", "-i", "--exclude-from", opts.shadowIgnoreFile],
          { env: { GIT_INDEX_FILE: tmpIndex } },
        ).split("\n").filter(Boolean);
        for (let i = 0; i < ignored.length; i += 100) {
          git(["rm", "--cached", "-f", "--", ...ignored.slice(i, i + 100)],
            { env: { GIT_INDEX_FILE: tmpIndex }, safe: true });
        }
      }

      const tree = git(["write-tree"], { env: { GIT_INDEX_FILE: tmpIndex } });

      // Map local parents → external parents
      const extParents: string[] = [];
      for (const parentHash of commit.parents) {
        const extParent = shaMapping.get(parentHash);
        if (extParent) {
          extParents.push(extParent);
        }
      }

      // Graft root commits onto the external seed hash
      if (extParents.length === 0 && graftBase) {
        extParents.push(graftBase);
      }

      // Build commit message with forward trailer
      const cleanMsg = meta.message.split("\n").filter(l => !l.match(/^Shadow-/)).join("\n").trimEnd();
      const message = appendTrailer(cleanMsg, `${FORWARD_TRAILER}: ${commit.hash}`);

      const parentArgs = extParents.flatMap(p => ["-p", p]);
      const newSHA = git(["commit-tree", tree, ...parentArgs, "-m", message], {
        env: {
          GIT_AUTHOR_NAME:      meta.authorName,
          GIT_AUTHOR_EMAIL:     meta.authorEmail,
          GIT_AUTHOR_DATE:      meta.authorDate,
          GIT_COMMITTER_NAME:   meta.committerName,
          GIT_COMMITTER_EMAIL:  meta.committerEmail,
          GIT_COMMITTER_DATE:   meta.committerDate,
        },
      });

      shaMapping.set(commit.hash, newSHA);
      lastSHA = newSHA;
      console.log("  ✓ Forwarded.");
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  console.log();
  console.log(`Done. ${newCommits.length} commit(s) forwarded.`);

  return { mirrored: newCommits.length, tipSHA: lastSHA, upToDate: false };
}
