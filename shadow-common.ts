import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RemoteConfig {
  /** Git remote name — must match `git remote add <name> <url>` */
  remote: string;
  /** Local subdirectory in your repo that maps to the root of that remote */
  dir: string;
}

/** All remotes you are shadowing. The first entry is the default used when
 *  neither -r nor -d is passed to the scripts.
 *
 *  Setup (once per remote):
 *    git remote add backend   git@their-server.com:backend.git
 *    git remote add frontend  git@their-server.com:frontend.git  */
export const REMOTES: RemoteConfig[] = [
  { remote: "backend",  dir: "backend"  },
  { remote: "frontend", dir: "frontend" },
];

export const SYNC_TRAILER   = "Shadow-synced-from";
export const PUSH_TRAILER   = "Shadow-pushed-from";
export const SEED_TRAILER   = "Shadow-seed";
export const EMPTY_TREE     = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Only mirror commits after this date. Set this to the date you stopped
 *  tracking the team via submodule. Accepts any format git understands:
 *    "2024-11-01"  |  "2024-11-01T09:00:00+01:00"  |  "1 month ago"
 *  Set to undefined to walk the full history (not recommended on mature repos). */
export let SYNC_SINCE: string | undefined = "2024-11-01";

/** Override the SYNC_SINCE cutoff at runtime (e.g. from a --since CLI flag). */
export function setSyncSince(val: string | undefined): void {
  SYNC_SINCE = val;
}

// Allow tests to inject config via environment variables.
// SHADOW_TEST_REMOTES is a JSON array of {remote, dir} objects (for multi-remote tests).
// SHADOW_TEST_REMOTE / SHADOW_TEST_DIR is the single-remote shorthand.
if (process.env.SHADOW_TEST_REMOTES) {
  REMOTES.length = 0;
  REMOTES.push(...JSON.parse(process.env.SHADOW_TEST_REMOTES));
} else if (process.env.SHADOW_TEST_REMOTE) {
  REMOTES.length = 0;
  REMOTES.push({
    remote: process.env.SHADOW_TEST_REMOTE,
    dir: process.env.SHADOW_TEST_DIR ?? process.env.SHADOW_TEST_REMOTE,
  });
}
if (process.env.SHADOW_TEST_SINCE !== undefined) {
  SYNC_SINCE = process.env.SHADOW_TEST_SINCE || undefined;
}

export type ApplyResult = "applied" | "conflict" | "failed";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommitMeta {
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

// ── Git helpers ───────────────────────────────────────────────────────────────

/** 50 MB — large enough for big binary diffs, prevents silent truncation. */
const MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Git config overrides for cross-OS consistency.
 * These ensure diffs and applies behave identically on Linux, macOS, and Windows:
 *   core.autocrlf=false  — prevent line-ending conversion that breaks patches
 *   core.safecrlf=false  — don't reject files with mixed line endings
 *   core.filemode=false  — ignore file permission changes (Windows has no chmod)
 *   core.precomposeunicode=true — normalize NFD→NFC on macOS
 */
const GIT_CONFIG_OVERRIDES = [
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "core.precomposeunicode=true",
  "-c", "core.quotepath=false",
];

/** Run a git command (pass args as an array), return trimmed stdout. Throws on non-zero exit. */
export function run(args: string[], cwd?: string): string {
  const result = spawnSync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
    encoding: "utf8",
    cwd,
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to spawn git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed (exit ${result.status}): ${stderr}`);
  }
  return (result.stdout ?? "").trim();
}

/** Run a git command (pass args as an array), return { stdout, stderr, status } — never throws. */
export function runSafe(args: string[], cwd?: string) {
  const result = spawnSync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
    encoding: "utf8",
    cwd,
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      stdout:  "",
      stderr:  `Failed to spawn git: ${result.error.message}`,
      status:  1,
      ok:      false,
    };
  }
  return {
    stdout:  (result.stdout ?? "").trim(),
    stderr:  (result.stderr ?? "").trim(),
    status:  result.status ?? 1,
    ok:      result.status === 0,
  };
}

export function getCurrentBranch(): string {
  const result = runSafe(["symbolic-ref", "--short", "HEAD"]);
  if (!result.ok) {
    die("You are in a detached HEAD state. Check out a branch first.");
  }
  return result.stdout;
}

export function refExists(ref: string): boolean {
  return runSafe(["rev-parse", "--verify", ref]).ok;
}

export function listTeamBranches(remote: string): string[] {
  return run(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

export function getCommitMeta(hash: string): CommitMeta {
  // Use a single git spawn with a delimiter to avoid 9 separate processes per commit.
  const SEP = "---SHADOW-SEP---";
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%B", "%h: %s", "%P"]
    .join(SEP);
  const raw = run(["log", "-1", `--format=${format}`, hash]);
  // %B (message body) may contain newlines, so split from both ends.
  // Fields before %B: an, ae, aD, cn, ce, cD (6 fields)
  // Fields after %B: short, parents (2 fields)
  const parts = raw.split(SEP);
  // First 6 and last 2 are single-line; everything in between is the message body.
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

/**
 * Apply a patch (raw diff string) under subdir using `git apply`.
 * Returns "applied" on clean apply, "conflict" if 3-way merge left
 * conflict markers, or "failed" if the patch couldn't be applied at all.
 */
export function applyPatch(patch: string, subdir: string): ApplyResult {
  const baseArgs = [...GIT_CONFIG_OVERRIDES, "apply", "--directory", subdir,
    "--ignore-whitespace"];

  // Write patch to a temp file to avoid Windows spawnSync stdin deadlocks.
  // Normalize line endings to LF so patches generated on any OS apply consistently.
  const normalizedPatch = patch.replace(/\r\n/g, "\n");
  const tmpPatch = path.join(os.tmpdir(), `shadow-patch-${process.pid}.patch`);
  fs.writeFileSync(tmpPatch, normalizedPatch);

  try {
    // 1) Try exact apply
    const result = spawnSync("git", [...baseArgs, tmpPatch], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error) throw new Error(`Failed to spawn git: ${result.error.message}`);
    if (result.status === 0) return "applied";

    // 2) Fall back to 3-way merge, same as git merge/rebase would.
    const threeWay = spawnSync("git", [...baseArgs, "--3way", tmpPatch], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: "inherit",
    });
    if (threeWay.error) throw new Error(`Failed to spawn git: ${threeWay.error.message}`);
    if (threeWay.status === 0) return "applied";

    // --3way exits non-zero when there are merge conflicts.
    // Check whether it produced conflict markers (unmerged entries)
    // vs failing entirely (e.g. missing blobs).
    const unmerged = runSafe(["diff", "--name-only", "--diff-filter=U"]);
    if (unmerged.ok && unmerged.stdout) {
      return "conflict";
    }

    return "failed";
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch (e: any) {
      if (e.code !== "ENOENT") console.warn(`Warning: failed to delete temp patch: ${e.message}`);
    }
  }
}

/**
 * Generate a diff for a commit, handling three cases:
 *   root commit   → diff against empty tree
 *   merge commit  → diff against first parent (^1) to capture conflict resolutions
 *   normal commit → diff against its single parent
 *
 * Returns the raw diff output (not trimmed) so the patch stays valid.
 */
export function diffForCommit(meta: CommitMeta): string {
  const { hash, parentCount } = meta;
  // --no-ext-diff: prevent external diff drivers from altering output
  // --no-textconv: prevent text conversion filters (important for cross-OS)
  // core.filemode=false: ignore permission changes that don't apply on Windows
  const diffArgs = [...GIT_CONFIG_OVERRIDES, "-c", "core.filemode=false",
    "diff", "--binary", "-M", "--no-ext-diff", "--no-textconv"];
  if (parentCount === 0) {
    const result = spawnSync("git", [...diffArgs, EMPTY_TREE, hash], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error) throw new Error(`Failed to spawn git: ${result.error.message}`);
    return result.stdout ?? "";
  }
  const parentRef = parentCount > 1 ? `${hash}^1` : `${hash}^`;
  const parentHash = run(["rev-parse", parentRef]);
  const result = spawnSync("git", [...diffArgs, parentHash, hash], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Failed to spawn git: ${result.error.message}`);
  return result.stdout ?? "";
}

/**
 * Commit with fully overridden author + committer metadata.
 * Optionally allow empty commits (for recording merge/empty syncs).
 */
export function commitWithMeta(
  meta: CommitMeta,
  message: string,
  allowEmpty = false,
): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME:      meta.authorName,
    GIT_AUTHOR_EMAIL:     meta.authorEmail,
    GIT_AUTHOR_DATE:      meta.authorDate,
    GIT_COMMITTER_NAME:   meta.committerName,
    GIT_COMMITTER_EMAIL:  meta.committerEmail,
    GIT_COMMITTER_DATE:   meta.committerDate,
  };
  const args = [...GIT_CONFIG_OVERRIDES, "commit", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message];
  const result = spawnSync("git", args, { env, encoding: "utf8", stdio: "inherit" });
  if (result.error) die(`Failed to spawn git: ${result.error.message}`);
  if (result.status !== 0) die("git commit failed.");
}

/**
 * Append a trailer to a commit message using `git interpret-trailers`,
 * which places it correctly after any existing trailers.
 */
export function appendTrailer(message: string, trailer: string): string {
  const result = spawnSync(
    "git",
    [...GIT_CONFIG_OVERRIDES, "interpret-trailers", "--trailer", trailer],
    { input: message, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.error || result.status !== 0) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

/**
 * Extract file paths mentioned in a unified diff patch.
 * Returns paths from the b/ side (the "to" file), which are the paths
 * that will be modified/created by applying the patch.
 * Also returns deleted paths (where b/ side is /dev/null).
 */
export function extractPatchFiles(patch: string, subdir: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const add = (p: string) => { if (!seen.has(p)) { seen.add(p); files.push(p); } };

  for (const line of patch.split("\n")) {
    // Match "diff --git a/foo b/bar"
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) {
      const rel = m[1];
      // Reject paths that attempt directory traversal or are absolute
      if (rel.includes("..") || rel.startsWith("/")) continue;
      add(`${subdir}/${rel}`);
      continue;
    }
    // Also catch deleted files from "--- a/foo" when "+++ /dev/null"
    const del = line.match(/^--- a\/(.+)$/);
    if (del && del[1] !== "/dev/null") {
      const rel = del[1];
      if (rel.includes("..") || rel.startsWith("/")) continue;
      add(`${subdir}/${rel}`);
    }
  }
  return files;
}

// ── .shadowignore ─────────────────────────────────────────────────────────────

export interface ShadowIgnore {
  patterns: string[];
}

export function parseShadowIgnore(scriptDir: string): ShadowIgnore {
  const ignoreFile = path.join(scriptDir, ".shadowignore");
  const patterns: string[] = [];

  if (fs.existsSync(ignoreFile)) {
    const lines = fs.readFileSync(ignoreFile, "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line) patterns.push(line);
    }
    console.log(`Loaded ${patterns.length} exclusion(s) from .shadowignore`);
  }

  return { patterns };
}

// ── History scan ──────────────────────────────────────────────────────────────

/**
 * Returns a Set of team commit hashes already mirrored into local history,
 * identified by Shadow-synced-from trailers.
 * Uses --grep so git pre-filters rather than scanning every commit body.
 */
const SYNCED_HASH_RE = new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`);

export function buildAlreadySyncedSet(): Set<string> {
  const synced = new Set<string>();
  const log = runSafe(["log", `--grep=^${SYNC_TRAILER}:`, "--format=%B"]);
  if (!log.ok || !log.stdout) return synced;

  for (const line of log.stdout.split("\n")) {
    const match = line.match(SYNCED_HASH_RE);
    if (match) synced.add(match[1]);
  }
  return synced;
}

/** Convenience overload: returns a set of already-synced hashes scoped to a
 *  specific local subdirectory, by limiting the log scan to commits that
 *  touched that path. Keeps dedup correct when tracking multiple remotes. */
export function buildAlreadySyncedSetFor(dir: string): Set<string> {
  const synced = new Set<string>();
  const log = runSafe(
    ["log", `--grep=^${SYNC_TRAILER}:`, "--format=%B", "--", `${dir}/`]
  );
  if (!log.ok || !log.stdout) return synced;

  for (const line of log.stdout.split("\n")) {
    const match = line.match(SYNCED_HASH_RE);
    if (match) synced.add(match[1]);
  }
  return synced;
}

/**
 * Find a seed hash for a given subdirectory.
 * Seed commits are empty commits with a `Shadow-seed: <dir> <hash>` trailer
 * created by `shadow-pull --seed` to establish a sync baseline.
 */
const SEED_HASH_RE = /^Shadow-seed:\s*(\S+)\s+([0-9a-f]{7,40})/;

export function findSeedHash(dir: string): string | null {
  const log = runSafe(["log", `--grep=^${SEED_TRAILER}:`, "--format=%B"]);
  if (!log.ok || !log.stdout) return null;
  for (const line of log.stdout.split("\n")) {
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir) return match[2];
  }
  return null;
}

/**
 * Find the default branch (main or master) on a remote.
 * Returns the branch name or null if neither exists.
 */
export function findRemoteDefaultBranch(remote: string): string | null {
  for (const name of ["main", "master"]) {
    if (refExists(`${remote}/${name}`)) return name;
  }
  return null;
}

/**
 * Collect all commits on a ref that are candidates for mirroring.
 * Applies SYNC_SINCE as an --after filter so the entire pre-submodule
 * history is skipped before the trailer dedup pass runs.
 *
 * Options:
 *   seedHash — exclude all commits at or before this hash (from --seed)
 *   baseRef  — exclude commits reachable from this ref (for feature branch ranges)
 */
export function collectTeamCommits(
  teamRef: string,
  opts?: { seedHash?: string; baseRef?: string },
): string[] {
  const args = ["log", "--reverse", "--format=%H"];
  if (SYNC_SINCE) args.push(`--after=${SYNC_SINCE}`);
  // Seed takes priority over baseRef (more specific exclusion)
  if (opts?.seedHash) {
    args.push(`${opts.seedHash}..${teamRef}`);
  } else if (opts?.baseRef) {
    args.push(`${opts.baseRef}..${teamRef}`);
  } else {
    args.push(teamRef);
  }
  const commits = runSafe(args);
  if (!commits.ok || !commits.stdout) return [];
  return commits.stdout.split("\n").filter(Boolean);
}

// ── Lockfile ──────────────────────────────────────────────────────────────────

export function acquireLock(scriptDir: string, name: string): () => void {
  const key   = crypto.createHash("md5").update(scriptDir).digest("hex").slice(0, 8);
  const lock  = path.join(os.tmpdir(), `${name}-${key}.lock`);
  const myPid = process.pid.toString();

  if (fs.existsSync(lock)) {
    const existingPid = fs.readFileSync(lock, "utf8").trim();
    let alive = false;
    // Validate PID is numeric before using in process checks
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
      if (e.code !== "ENOENT") throw e; // OK if already deleted by another process
    }
  }

  // Use O_EXCL for atomic creation — prevents TOCTOU race between
  // checking the lock and writing it.
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

  return release;
}

// ── Conflict state ────────────────────────────────────────────────────────────

interface ConflictState {
  hash: string;
  remote: string;
  dir: string;
}

function conflictStatePath(scriptDir: string): string {
  const key = crypto.createHash("md5").update(scriptDir).digest("hex").slice(0, 8);
  return path.join(os.tmpdir(), `shadow-pull-conflict-${key}.json`);
}

export function saveConflictState(scriptDir: string, state: ConflictState): void {
  fs.writeFileSync(conflictStatePath(scriptDir), JSON.stringify(state));
}

export function loadConflictState(scriptDir: string): ConflictState | null {
  const p = conflictStatePath(scriptDir);
  if (!fs.existsSync(p)) return null;
  try {
    const loaded = JSON.parse(fs.readFileSync(p, "utf8"));
    // Validate required fields exist and are strings
    if (typeof loaded.hash !== "string" || typeof loaded.remote !== "string" || typeof loaded.dir !== "string") {
      console.warn("Warning: invalid conflict state file, ignoring.");
      return null;
    }
    return loaded as ConflictState;
  } catch {
    console.warn("Warning: corrupt conflict state file, ignoring.");
    return null;
  }
}

export function clearConflictState(scriptDir: string): void {
  const p = conflictStatePath(scriptDir);
  try { fs.unlinkSync(p); } catch (e: any) {
    if (e.code !== "ENOENT") console.warn(`Warning: failed to clear conflict state: ${e.message}`);
  }
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

export interface PreflightWarning {
  level: "error" | "warn";
  code: string;
  message: string;
}

/**
 * Run pre-flight checks before pull or push.
 * Returns an array of warnings/errors. Callers should abort on "error" level.
 */
export function preflightChecks(remote: string, teamRef: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];

  // 1. Shallow clone detection
  const shallow = runSafe(["rev-parse", "--is-shallow-repository"]);
  if (shallow.ok && shallow.stdout === "true") {
    warnings.push({
      level: "error",
      code: "SHALLOW_CLONE",
      message: "This repository is a shallow clone. Shadow sync requires full history.\n"
        + "  Run: git fetch --unshallow",
    });
  }

  // 2. Check remote tree for problematic entries
  const tree = runSafe(["ls-tree", "-r", "--long", teamRef]);
  if (tree.ok && tree.stdout) {
    const entries = tree.stdout.split("\n").filter(Boolean);
    const paths: string[] = [];

    for (const entry of entries) {
      // Format: <mode> <type> <hash> <size>\t<path>
      const match = entry.match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\s+[\d-]+\t(.+)$/);
      if (!match) continue;
      const [, mode, , filePath] = match;
      paths.push(filePath);

      // Submodule detection (mode 160000)
      if (mode === "160000") {
        warnings.push({
          level: "warn",
          code: "SUBMODULE",
          message: `Remote contains a submodule at '${filePath}'. Submodules cannot be synced and will be skipped.`,
        });
      }

      // Symlink detection (mode 120000)
      if (mode === "120000") {
        warnings.push({
          level: "warn",
          code: "SYMLINK",
          message: `Remote contains a symlink at '${filePath}'. Symlink targets are not adjusted for the monorepo subdirectory.`,
        });
      }
    }

    // 3. Case conflict detection (only matters on case-insensitive FS)
    if (process.platform === "win32" || process.platform === "darwin") {
      const lower = new Map<string, string>();
      for (const p of paths) {
        const key = p.toLowerCase();
        const existing = lower.get(key);
        if (existing && existing !== p) {
          warnings.push({
            level: "error",
            code: "CASE_CONFLICT",
            message: `Case conflict: '${existing}' and '${p}' differ only in case.\n`
              + "  This will cause data loss on case-insensitive filesystems (Windows/macOS).",
          });
        }
        lower.set(key, p);
      }
    }
  }

  // 4. LFS detection — check for .gitattributes with filter=lfs
  const attrs = runSafe(["show", `${teamRef}:.gitattributes`]);
  if (attrs.ok && attrs.stdout.includes("filter=lfs")) {
    warnings.push({
      level: "warn",
      code: "GIT_LFS",
      message: "Remote uses Git LFS. Shadow sync will transfer LFS pointer files, not actual content.\n"
        + "  Ensure LFS is configured in the monorepo, or large files will be pointers.",
    });
  }

  return warnings;
}

/**
 * Print preflight warnings and abort on errors.
 * Returns true if there are only warnings (safe to continue), false if there were errors.
 */
export function handlePreflightResults(warnings: PreflightWarning[]): boolean {
  if (warnings.length === 0) return true;

  const errors = warnings.filter(w => w.level === "error");
  const warns  = warnings.filter(w => w.level === "warn");

  for (const w of warns) {
    console.error(`⚠ [${w.code}] ${w.message}`);
  }
  for (const e of errors) {
    console.error(`✘ [${e.code}] ${e.message}`);
  }

  if (errors.length > 0) {
    console.error(`\nAborting due to ${errors.length} error(s).`);
    return false;
  }
  return true;
}

// ── Misc ──────────────────────────────────────────────────────────────────────

/** Validate that a dir/remote name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) die(`${label} must not be empty.`);
  if (value.includes("..")) die(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) die(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) die(`${label} must not start with '-'.`);
}

export function die(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}
