#!/usr/bin/env ts-node
/**
 * shadow-export.ts — Merge local changes into the shadow branch,
 * filtering out .shadowignore files. Creates a proper merge commit
 * so the shadow branch has real ancestry back to your working branch.
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
  REMOTES, MAX_PUSH_RETRIES,
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

if (values.help) {
  console.log('Usage: shadow-export.ts [-m "commit message"] [-r remote] [-d dir] [-b branch] [-n]');
  console.log("  -m  Commit message                        (default: git's merge commit message)");
  console.log("  -r  Remote name (selects config entry)    (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory to export from     (default: same as remote name)");
  console.log("  -b  Target branch                         (default: your current branch)");
  console.log("  -n  Dry run — show what would change without pushing");
  process.exit(0);
}

const dryRun = values["dry-run"] ?? false;
const commitMsg = values.message;

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const localBranch = getCurrentBranch();
const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  die(`Remote '${values.remote}' not found in REMOTES. Add it to shadow-config.json.`);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const externalBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");
const shadowBranch = shadowBranchName(dir, externalBranch);
const pushOrigin   = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowRef    = `${pushOrigin}/${shadowBranch}`;

// Refuse to export if the local dir has uncommitted changes
const dirtyStaged   = !runSafe(["diff", "--cached", "--quiet", "--", `${dir}/`]).ok;
const dirtyUnstaged = !runSafe(["diff", "--quiet", "HEAD", "--", `${dir}/`]).ok;
if (dirtyStaged || dirtyUnstaged) {
  console.error(`\u2718 '${dir}/' has uncommitted changes:\n`);
  spawnSync("git", ["-c", "core.autocrlf=false", "status", "--short", "--", `${dir}/`], { stdio: "inherit" });
  console.error(`\nCommit or stash them before running shadow-export.`);
  process.exit(1);
}

acquireLock(SCRIPT_DIR, "shadow-export");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Shadow branch : ${shadowBranch}\n`);

// ── .shadowignore ─────────────────────────────────────────────────────────────

const ignorePatterns = parseShadowIgnore(SCRIPT_DIR);

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
run(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist. Run shadow-setup.ts first.`);
}

// Refuse to export if the shadow branch has changes not merged into HEAD.
// This catches external commits (synced via CI) that the user hasn't pulled yet.
if (!runSafe(["merge-base", "--is-ancestor", shadowRef, "HEAD"]).ok) {
  console.error(`\u2718 '${shadowRef}' has commits not merged into your local branch.\n`);
  console.error(`Merge them first:`);
  console.error(`  git fetch ${pushOrigin}`);
  console.error(`  git merge ${shadowRef}\n`);
  console.error(`Then re-run the export.`);
  process.exit(1);
}

// ── Worktree ──────────────────────────────────────────────────────────────────

const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-export-")).replace(/\\/g, "/");
const tempBranch  = `shadow-export-${Date.now()}`;
let   cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(["worktree", "remove", "--force", worktreeDir]);
  runSafe(["branch", "-D", tempBranch]);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
};

process.on("exit",    cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

run(["worktree", "add", "-b", tempBranch, worktreeDir, shadowRef]);

// ── Merge ─────────────────────────────────────────────────────────────────────
// Merge HEAD into shadow with --no-commit so we can clean the index.
// -X theirs prefers local (HEAD) on conflict.  --allow-unrelated-histories
// is harmless when histories are related and avoids a retry path.

const headCommit = run(["rev-parse", "HEAD"]);
console.log(`Merging ${localBranch} (${headCommit.slice(0, 10)}) into shadow branch...`);

const mergeResult = runSafe(
  ["merge", "--no-commit", "--no-ff", "-X", "theirs", "--allow-unrelated-histories", headCommit],
  worktreeDir,
);

if (!mergeResult.ok && !runSafe(["rev-parse", "MERGE_HEAD"], worktreeDir).ok) {
  console.error(mergeResult.stderr);
  die("Merge failed. Resolve conflicts manually and retry.");
}

// ── Clean index ───────────────────────────────────────────────────────────────
// Strip to only dir/ files minus shadowignored patterns.
// MERGE_HEAD is still present so the commit will record both parents.

console.log(`Cleaning index (removing files outside '${dir}/' and shadowignored files)...`);

const allIndexed = run(["ls-files"], worktreeDir).split("\n").filter(Boolean);

// Keep files needed by CI workflows on the shadow branch. GitHub reads
// workflow files from the pushed branch, and the forward job needs
// package.json, the forward script, and shared modules to run.
const ciKeep = [".github/", "shadow/"];
const nonDirFiles = allIndexed.filter(f =>
  !f.startsWith(`${dir}/`) && !ciKeep.some(p => f.startsWith(p))
);
for (let i = 0; i < nonDirFiles.length; i += 100) {
  runSafe(["rm", "--cached", "-f", "--", ...nonDirFiles.slice(i, i + 100)], worktreeDir);
}

if (ignorePatterns.length > 0) {
  const compiled = ignorePatterns.map(globToRegex);
  const ignoredFiles = run(["ls-files", "--", `${dir}/`], worktreeDir)
    .split("\n").filter(Boolean)
    .filter(f => compiled.some(re => re.test(f.slice(dir.length + 1))));
  for (let i = 0; i < ignoredFiles.length; i += 100) {
    runSafe(["rm", "--cached", "-f", "--", ...ignoredFiles.slice(i, i + 100)], worktreeDir);
  }
}

// ── Commit & push ─────────────────────────────────────────────────────────────

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

const commitArgs = ["-c", "core.autocrlf=false", "commit", ...(commitMsg ? ["-m", commitMsg] : [])];
const commitResult = spawnSync("git", commitArgs, {
  cwd: worktreeDir, encoding: "utf8", stdio: "inherit",
});
if (commitResult.error) die(`Failed to spawn git: ${commitResult.error.message}`);
if (commitResult.status !== 0) die("git commit failed in worktree.");

console.log(`Pushing to ${pushOrigin}/${shadowBranch}...`);

for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
  const pushResult = runSafe(["push", pushOrigin, `HEAD:${shadowBranch}`], worktreeDir);
  if (pushResult.ok) break;
  const isNonFF = /non-fast-forward|rejected|fetch first/.test(pushResult.stderr);
  if (!isNonFF || attempt === MAX_PUSH_RETRIES) {
    console.error(pushResult.stderr);
    die(`git push failed after ${attempt} attempt(s).`);
  }
  console.log(`  Push rejected (non-fast-forward), retrying (${attempt}/${MAX_PUSH_RETRIES})...`);
  run(["fetch", pushOrigin]);
  const updatedRef = run(["rev-parse", `${pushOrigin}/${shadowBranch}`]);
  if (!runSafe(["rebase", updatedRef], worktreeDir).ok) {
    die("Rebase onto updated shadow branch failed. Resolve manually and retry.");
  }
}

cleanup();
console.log(`\n\u2713 Done. Exported '${dir}/' \u2192 ${pushOrigin}/${shadowBranch}`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const re = pattern
    .replace(/\*\*\/?/g, '\0')       // ** or **/ → placeholder
    .replace(/[.+^${}()|\\]/g, '\\$&') // escape regex specials
    .replace(/\*/g, '[^/]*')          // * → any non-slash
    .replace(/\?/g, '[^/]')           // ? → single non-slash
    .replace(/\0/g, '.*');            // placeholder → any path
  return new RegExp(`^${re}$`);
}
