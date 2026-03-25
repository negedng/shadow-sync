#!/usr/bin/env ts-node
/**
 * shadow-export.ts — Export local subdirectory changes to a shadow branch,
 * filtering out files matched by .shadowignore.
 *
 * This is the local step for pushing changes to an external team repo.
 * The CI forward workflow (shadow-ci-forward.ts) handles the actual push
 * to the external remote.
 *
 * Usage:
 *   npx tsx shadow-export.ts -m "Add login page"
 *   npx tsx shadow-export.ts -r backend -m "Fix API bug"
 *   npx tsx shadow-export.ts -r frontend -b feature/new-page -m "Add new page"
 */
import { parseArgs } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import {
  REMOTES, MAX_DIR_DEPTH, MAX_PUSH_RETRIES,
  run, runSafe, refExists,
  getCurrentBranch, shadowBranchName,
  parseShadowIgnore, acquireLock, validateName, die,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    message:   { type: "string",  short: "m" },
    remote:    { type: "string",  short: "r" },
    dir:       { type: "string",  short: "d" },
    branch:    { type: "string",  short: "b" },
    "dry-run": { type: "boolean", short: "n" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help || !values.message) {
  console.log('Usage: shadow-export.ts -m "Your commit message" [-r remote] [-d dir] [-b branch] [-n]');
  console.log("  -m  Commit message (required)");
  console.log("  -r  Remote name (selects config entry)    (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory to export from     (default: same as remote name)");
  console.log("  -b  Target branch                         (default: your current branch)");
  console.log("  -n  Dry run — show what would change without pushing");
  process.exit(values.help ? 0 : 1);
}

const dryRun = values["dry-run"] ?? false;
const commitMsg = values.message;

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const localBranch = getCurrentBranch();

const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  die(`Remote '${values.remote}' not found in REMOTES. Add it to shadow-config.json.`);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const teamBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");
const shadowBranch = shadowBranchName(dir, teamBranch);
// Configurable via env var for testing.
const pushOrigin   = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowRef    = `${pushOrigin}/${shadowBranch}`;

// Refuse to export if the local dir has uncommitted changes
const dirtyStaged   = !runSafe(["diff", "--cached", "--quiet", "--", `${dir}/`]).ok;
const dirtyUnstaged = !runSafe(["diff", "--quiet", "HEAD", "--", `${dir}/`]).ok;
if (dirtyStaged || dirtyUnstaged) {
  console.error(`✘ '${dir}/' has uncommitted changes:\n`);
  spawnSync("git", ["-c", "core.autocrlf=false", "status", "--short", "--", `${dir}/`], { stdio: "inherit" });
  console.error(`\nCommit or stash them before running shadow-export.`);
  process.exit(1);
}

acquireLock(SCRIPT_DIR, "shadow-export");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Shadow branch : ${shadowBranch}`);
console.log();

// ── .shadowignore ─────────────────────────────────────────────────────────────

const ignore = parseShadowIgnore(SCRIPT_DIR);

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
run(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist. Run shadow-setup.ts first.`);
}

// ── Worktree ──────────────────────────────────────────────────────────────────

const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-export-")).replace(/\\/g, "/");
const archiveDir  = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-archive-")).replace(/\\/g, "/");
const tempBranch  = `shadow-export-${Date.now()}`;
let   cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(["worktree", "remove", "--force", worktreeDir]);
  runSafe(["branch", "-D", tempBranch]);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.rmSync(archiveDir,  { recursive: true, force: true });
};

process.on("exit",    cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

console.log(`Extracting committed '${dir}/' from HEAD (applying .shadowignore)...`);

const trackedFiles = run(["ls-tree", "-r", "--name-only", "HEAD", "--", `${dir}/`])
  .split("\n")
  .filter(Boolean);

for (const filePath of trackedFiles) {
  // filePath is e.g. "backend/README.md" — strip dir prefix for ignore check
  const rel = filePath.slice(dir.length + 1);
  if (ignore.patterns.some(p => rel.match(globToRegex(p)))) continue;

  const destPath = path.join(archiveDir, filePath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const gitPath = filePath.replace(/\\/g, "/");
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "show", `HEAD:${gitPath}`], {
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) die(`Failed to spawn git: ${result.error.message}`);
  if (result.status !== 0) die(`Failed to extract ${gitPath} from HEAD`);
  fs.writeFileSync(destPath, result.stdout);
}

run(["worktree", "add", "-b", tempBranch, worktreeDir, shadowRef]);

console.log(`Syncing into temporary worktree...`);

syncDirs(archiveDir, worktreeDir, dir);

// ── Commit & push ─────────────────────────────────────────────────────────────

run(["add", "-A"], worktreeDir);

const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"], worktreeDir).ok;
if (!hasStagedChanges) {
  console.log("No changes to export — shadow branch is already up to date.");
  cleanup();
  process.exit(0);
}

console.log("\nChanges to export:");
spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--cached", "--stat"], { cwd: worktreeDir, stdio: "inherit" });
console.log();

if (dryRun) {
  console.log("[DRY RUN] No changes were exported.");
  cleanup();
  process.exit(0);
}

const commitResult = spawnSync("git", ["-c", "core.autocrlf=false", "commit", "-m", commitMsg], {
  cwd: worktreeDir,
  encoding: "utf8",
  stdio: "inherit",
});
if (commitResult.error) die(`Failed to spawn git: ${commitResult.error.message}`);
if (commitResult.status !== 0) die("git commit failed in worktree.");

console.log(`Pushing to ${pushOrigin}/${shadowBranch}...`);

for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
  const pushResult = runSafe(["push", pushOrigin, `HEAD:${shadowBranch}`], worktreeDir);
  if (pushResult.ok) break;
  const isNonFF = pushResult.stderr.includes("non-fast-forward")
    || pushResult.stderr.includes("rejected")
    || pushResult.stderr.includes("fetch first");
  if (!isNonFF || attempt === MAX_PUSH_RETRIES) {
    console.error(pushResult.stderr);
    die(`git push failed after ${attempt} attempt(s).`);
  }
  console.log(`  Push rejected (non-fast-forward), retrying (${attempt}/${MAX_PUSH_RETRIES})...`);
  run(["fetch", pushOrigin]);
  if (refExists(`${pushOrigin}/${shadowBranch}`)) {
    const updatedRef = run(["rev-parse", `${pushOrigin}/${shadowBranch}`]);
    const rebaseResult = runSafe(["rebase", updatedRef], worktreeDir);
    if (!rebaseResult.ok) {
      die("Rebase onto updated shadow branch failed. Resolve manually and retry.");
    }
  }
}

cleanup();

console.log();
console.log(`✓ Done. Exported '${dir}/' → ${pushOrigin}/${shadowBranch} as: "${commitMsg}"`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function syncDirs(src: string, dest: string, subdir: string) {
  const srcSubdir = path.join(src, subdir);
  const destSubdir = path.join(dest, subdir);

  if (fs.existsSync(destSubdir)) {
    const destFiles = listAllFiles(destSubdir);
    for (const rel of destFiles) {
      const srcPath = path.join(srcSubdir, rel);
      if (!fs.existsSync(srcPath)) {
        fs.rmSync(path.join(destSubdir, rel), { force: true });
      }
    }
  }
  if (fs.existsSync(srcSubdir)) {
    const srcFiles = listAllFiles(srcSubdir);
    for (const rel of srcFiles) {
      const srcPath = path.join(srcSubdir, rel);
      const destPath = path.join(destSubdir, rel);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function listAllFiles(dir: string, prefix = "", depth = 0): string[] {
  if (depth > MAX_DIR_DEPTH) {
    console.warn(`Warning: skipping directory at depth ${depth}: ${dir}`);
    return [];
  }
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      results.push(...listAllFiles(path.join(dir, entry.name), rel, depth + 1));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close !== -1) {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        re += "\\[";
        i++;
      }
    } else if (".+^${}()|\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}
