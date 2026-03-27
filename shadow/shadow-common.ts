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
  url?: string;
}

interface ShadowSyncConfig {
  remotes: RemoteConfig[];
  trailers: { sync: string; seed: string };
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  maxDirDepth: number;
  maxPushRetries: number;
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
    },
    gitConfigOverrides: (doc.gitConfigOverrides as Record<string, string>) ?? {},
    maxBuffer:          (doc.maxBuffer as number) ?? 50 * 1024 * 1024,
    maxDirDepth:        (doc.maxDirDepth as number) ?? 100,
    maxPushRetries:     (doc.maxPushRetries as number) ?? 3,
    shadowBranchPrefix: (doc.shadowBranchPrefix as string) ?? "shadow",
  };
}

const config = loadConfig();

export const REMOTES: RemoteConfig[] = [...config.remotes];
const SYNC_TRAILER   = config.trailers.sync;
export const SEED_TRAILER   = config.trailers.seed;
export const MAX_DIR_DEPTH  = config.maxDirDepth;
export const MAX_PUSH_RETRIES = config.maxPushRetries;
export const SHADOW_BRANCH_PREFIX = config.shadowBranchPrefix;

// Allow tests to inject config via environment variable (JSON array of RemoteConfig).
if (process.env.SHADOW_TEST_REMOTES) {
  REMOTES.length = 0;
  REMOTES.push(...JSON.parse(process.env.SHADOW_TEST_REMOTES));
}

// ── Git helpers ───────────────────────────────────────────────────────────────

const MAX_BUFFER = config.maxBuffer;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

function git(args: string[], cwd?: string) {
  return spawnSync("git", [...GIT_CONFIG_OVERRIDES, ...args], {
    encoding: "utf8", cwd, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Run a git command, return trimmed stdout. Throws on non-zero exit. */
export function run(args: string[], cwd?: string): string {
  const r = git(args, cwd);
  if (r.error) throw new Error(`Failed to spawn git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** Run a git command, return { stdout, stderr, status, ok } — never throws. */
export function runSafe(args: string[], cwd?: string) {
  const r = git(args, cwd);
  if (r.error) return { stdout: "", stderr: `Failed to spawn git: ${r.error.message}`, status: 1, ok: false };
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status ?? 1,
    ok:     r.status === 0,
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

export function listExternalBranches(remote: string): string[] {
  return run(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

// ── .shadowignore ─────────────────────────────────────────────────────────────

export function parseShadowIgnore(scriptDir: string): string[] {
  const ignoreFile = path.join(scriptDir, ".shadowignore");
  if (!fs.existsSync(ignoreFile)) return [];

  const patterns = fs.readFileSync(ignoreFile, "utf8")
    .split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
  console.log(`Loaded ${patterns.length} exclusion(s) from .shadowignore`);
  return patterns;
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

/**
 * Run pre-flight checks before sync.
 * Returns an array of warnings/errors. Callers should abort on "error" level.
 */
export function preflightChecks(externalRef: string): { level: "error" | "warn"; code: string; message: string }[] {
  type W = { level: "error" | "warn"; code: string; message: string };
  const warnings: W[] = [];
  const warn  = (code: string, message: string) => warnings.push({ level: "warn", code, message });
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = runSafe(["rev-parse", "--is-shallow-repository"]);
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  const tree = runSafe(["ls-tree", "-r", "--long", externalRef]);
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

  const attrs = runSafe(["show", `${externalRef}:.gitattributes`]);
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

/** Append a trailer to a commit message using `git interpret-trailers`. */
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

// ── Shadow branch helpers ────────────────────────────────────────────────────

/** Build the canonical shadow branch name: shadow/{dir}/{branch} */
export function shadowBranchName(dir: string, branch: string): string {
  return `${SHADOW_BRANCH_PREFIX}/${dir}/${branch}`;
}


// ── Lockfile ──────────────────────────────────────────────────────────────────

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

// ── Replay engine (internal helpers + exported entry point) ───────────────────

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
  const raw = run(["log", "-1", `--format=${format}`, hash]);
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

function applyPatch(patch: string, subdir: string): boolean {
  const normalizedPatch = patch.replace(/\r\n/g, "\n");
  const tmpPatch = path.join(os.tmpdir(), `shadow-patch-${process.pid}.patch`);
  fs.writeFileSync(tmpPatch, normalizedPatch);

  try {
    const result = spawnSync("git", [
      ...GIT_CONFIG_OVERRIDES, "apply", "--directory", subdir,
      "--ignore-whitespace", tmpPatch,
    ], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error) throw new Error(`Failed to spawn git: ${result.error.message}`);
    return result.status === 0;
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch (e: any) {
      if (e.code !== "ENOENT") console.warn(`Warning: failed to delete temp patch: ${e.message}`);
    }
  }
}

function diffForCommit(meta: CommitMeta): string {
  const { hash, parentCount } = meta;
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
  const parentHash = run(["rev-parse", `${hash}^1`]);
  const result = spawnSync("git", [...diffArgs, parentHash, hash], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Failed to spawn git: ${result.error.message}`);
  return result.stdout ?? "";
}

function commitWithMeta(meta: CommitMeta, message: string, allowEmpty = false): void {
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

function extractPatchFiles(patch: string, subdir: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    if (m && m[1] !== "/dev/null" && !m[1].includes("..") && !m[1].startsWith("/")) {
      files.add(`${subdir}/${m[1]}`);
    }
  }
  return [...files];
}

const SYNCED_HASH_RE = new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`);

function buildAlreadySyncedSetFor(dir: string): Set<string> {
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

const SEED_HASH_RE = /^Shadow-seed:\s*(\S+)\s+([0-9a-f]{7,40})/;

function findSeedHash(dir: string): string | null {
  const log = runSafe(["log", "--all", `--grep=^${SEED_TRAILER}:`, "--format=%B"]);
  if (!log.ok || !log.stdout) return null;
  for (const line of log.stdout.split("\n")) {
    const match = line.match(SEED_HASH_RE);
    if (match && match[1] === dir) return match[2];
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
  const commits = runSafe(args);
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

  console.log("Scanning local history for already-mirrored commits...");
  const alreadySynced = buildAlreadySyncedSetFor(dir);
  console.log(`Found ${alreadySynced.size} previously mirrored commit(s).`);

  const seedHash = findSeedHash(dir);
  if (seedHash) {
    console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
  }

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

  for (const hash of newCommits) {
    const meta = getCommitMeta(hash);

    // Skip commits that were forwarded by us — they'd create a round-trip duplicate.
    if (meta.message.includes("Shadow-forwarded-from:")) {
      console.log(`  Skipping ${meta.short} (forwarded by us).`);
      alreadySynced.add(hash);
      const cleanMsg = meta.message.split("\n").filter(l => !l.match(/^Shadow-/)).join("\n").trimEnd();
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

    const patch = diffForCommit(meta);
    const result = applyPatch(patch, dir);

    if (!result) {
      throw new Error(`Could not apply patch for ${meta.short}. Shadow branch may be out of sync.`);
    }

    const patchFiles = extractPatchFiles(patch, dir);
    if (patchFiles.length > 0) {
      run(["add", "--", ...patchFiles]);
    }

    const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"]).ok;
    const syncedMessage    = appendTrailer(meta.message, `${SYNC_TRAILER}: ${hash}`);

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
