import { execSync, spawnSync } from "child_process";
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
 *    git remote add team      git@their-server.com:backend.git
 *    git remote add frontend  git@their-server.com:frontend.git  */
export const REMOTES: RemoteConfig[] = [
  { remote: "team",     dir: "backend"  },
  { remote: "frontend", dir: "frontend" },
];

export const SYNC_TRAILER   = "Shadow-synced-from";
export const PUSH_TRAILER   = "Shadow-pushed-from";
export const EMPTY_TREE     = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Only mirror commits after this date. Set this to the date you stopped
 *  tracking the team via submodule. Accepts any format git understands:
 *    "2024-11-01"  |  "2024-11-01T09:00:00+01:00"  |  "1 month ago"
 *  Set to undefined to walk the full history (not recommended on mature repos). */
export const SYNC_SINCE: string | undefined = "2024-11-01";

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

/** Run a command, return trimmed stdout. Throws on non-zero exit. */
export function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run a command, return { stdout, stderr, status } — never throws. */
export function runSafe(cmd: string, cwd?: string) {
  const result = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    cwd,
  });
  return {
    stdout:  (result.stdout ?? "").trim(),
    stderr:  (result.stderr ?? "").trim(),
    status:  result.status ?? 1,
    ok:      result.status === 0,
  };
}

export function getCurrentBranch(): string {
  const result = runSafe("git symbolic-ref --short HEAD");
  if (!result.ok) {
    die("You are in a detached HEAD state. Check out a branch first.");
  }
  return result.stdout;
}

export function refExists(ref: string): boolean {
  return runSafe(`git rev-parse --verify ${ref}`).ok;
}

export function listTeamBranches(remote: string): string[] {
  return run(`git branch -r`)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""));
}

export function getCommitMeta(hash: string): CommitMeta {
  const fmt = (f: string) => run(`git log -1 --format="${f}" ${hash}`);
  return {
    hash,
    authorName:     fmt("%an"),
    authorEmail:    fmt("%ae"),
    authorDate:     fmt("%aD"),
    committerName:  fmt("%cn"),
    committerEmail: fmt("%ce"),
    committerDate:  fmt("%cD"),
    message:        fmt("%B"),
    short:          fmt("%h: %s"),
    parentCount:    fmt("%P").split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Apply a patch (raw diff string) under subdir using `git apply`.
 * Returns true on success, false on failure.
 * On failure re-applies with --reject so .rej files are created for manual resolution.
 */
export function applyPatch(patch: string, subdir: string): boolean {
  const applyArgs = ["apply", "--directory", subdir, "--ignore-whitespace"];

  const result = spawnSync("git", applyArgs, {
    input: patch,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status === 0) return true;

  spawnSync("git", [...applyArgs, "--reject"], {
    input: patch,
    encoding: "utf8",
    stdio: "inherit",
  });

  return false;
}

/**
 * Generate a diff for a commit, handling three cases:
 *   root commit   → diff against empty tree
 *   merge commit  → diff against first parent (^1) to capture conflict resolutions
 *   normal commit → diff against its single parent
 */
export function diffForCommit(meta: CommitMeta): string {
  const { hash, parentCount } = meta;
  if (parentCount === 0) {
    return run(`git diff ${EMPTY_TREE} ${hash}`);
  }
  const parent = parentCount > 1 ? `${hash}^1` : `${hash}^`;
  return run(`git diff ${parent} ${hash}`);
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
  const args = ["commit", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message];
  const result = spawnSync("git", args, { env, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) die("git commit failed.");
}

/**
 * Append a trailer to a commit message using `git interpret-trailers`,
 * which places it correctly after any existing trailers.
 */
export function appendTrailer(message: string, trailer: string): string {
  const result = spawnSync(
    "git",
    ["interpret-trailers", "--trailer", trailer],
    { input: message, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

// ── .shadowignore ─────────────────────────────────────────────────────────────

export interface ShadowIgnore {
  patterns:      string[];
  rsyncExcludes: string[];
  rsyncProtects: string[];
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

  return {
    patterns,
    rsyncExcludes: patterns.map(p => `--exclude=${p}`),
    rsyncProtects: patterns.map(p => `--filter=protect ${p}`),
  };
}

// ── History scan ──────────────────────────────────────────────────────────────

/**
 * Returns a Set of team commit hashes already mirrored into local history,
 * identified by Shadow-synced-from trailers.
 * Uses --grep so git pre-filters rather than scanning every commit body.
 */
export function buildAlreadySyncedSet(): Set<string> {
  const synced = new Set<string>();
  const log = runSafe(`git log --grep="^${SYNC_TRAILER}:" --format="%B"`);
  if (!log.ok || !log.stdout) return synced;

  for (const line of log.stdout.split("\n")) {
    const match = line.match(new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`));
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
    `git log --grep="^${SYNC_TRAILER}:" --format="%B" -- ${dir}/`
  );
  if (!log.ok || !log.stdout) return synced;

  for (const line of log.stdout.split("\n")) {
    const match = line.match(new RegExp(`^${SYNC_TRAILER}:\\s*([0-9a-f]{7,40})`));
    if (match) synced.add(match[1]);
  }
  return synced;
}

/**
 * Collect all commits on a ref that are candidates for mirroring.
 * Applies SYNC_SINCE as an --after filter so the entire pre-submodule
 * history is skipped before the trailer dedup pass runs.
 */
export function collectTeamCommits(teamRef: string): string[] {
  const sinceFlag = SYNC_SINCE ? `--after="${SYNC_SINCE}"` : "";
  const commits = runSafe(
    `git log --reverse --format="%H" ${sinceFlag} ${teamRef}`
  );
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
    const alive = runSafe(`kill -0 ${existingPid}`).ok;
    if (alive) die(`Another ${name} is already running (PID ${existingPid}).`);
    fs.unlinkSync(lock);
  }

  fs.writeFileSync(lock, myPid);

  const release = () => {
    if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8").trim() === myPid) {
      fs.unlinkSync(lock);
    }
  };

  process.on("exit",    release);
  process.on("SIGINT",  () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });

  return release;
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function die(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}
