#!/usr/bin/env ts-node
/**
 * shadow-export.ts — Export local changes to the shadow branch.
 *
 * 1. Runs ci-sync locally to ensure shadow branch has latest external changes.
 *    Skipped with --no-sync.
 * 2. Builds a filtered tree (applying .shadowignore) and creates a merge commit
 *    so the shadow branch has real ancestry back to your working branch.
 *
 * Usage:
 *   npx tsx shadow-export.ts -m "Add login page"
 *   npx tsx shadow-export.ts -r backend -m "Fix API bug"
 *   npx tsx shadow-export.ts -r frontend -b feature/new-page -m "Add new page"
 *   npx tsx shadow-export.ts --no-sync
 */
import { parseArgs } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import {
  REMOTES,
  git, refExists, appendTrailer,
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
    "no-sync": { type: "boolean" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log('Usage: shadow-export.ts [-m "commit message"] [-r remote] [-d dir] [-b branch] [-n] [--no-sync]');
  console.log("  -m         Commit message                        (default: auto-generated summary)");
  console.log("  -r         Remote name (selects config entry)    (default: first entry in REMOTES)");
  console.log("  -d         Local subdirectory to export from     (default: same as remote name)");
  console.log("  -b         Target branch                         (default: your current branch)");
  console.log("  -n         Dry run — show what would change without pushing");
  console.log("  --no-sync  Skip syncing external changes before export");
  process.exit(0);
}

const dryRun = values["dry-run"] ?? false;
const commitMsg = values.message;

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;

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
const dirtyStaged   = !git(["diff", "--cached", "--quiet", "--", `${dir}/`], { safe: true, plain: true }).ok;
const dirtyUnstaged = !git(["diff", "--quiet", "HEAD", "--", `${dir}/`], { safe: true, plain: true }).ok;
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

// ── Sync external changes ────────────────────────────────────────────────────

if (!values["no-sync"]) {
  console.log("Running local sync (fetching external changes)...");

  const stashed = git(["stash", "push", "-u", "-m", "shadow-export: pre-sync stash"], { safe: true, plain: true }).ok;

  const ciSyncPath = path.join(__dirname, "shadow-ci-sync.ts");
  const tsxPath = require.resolve("tsx/cli");
  const result = spawnSync(process.execPath, [tsxPath, ciSyncPath, "-r", remote], {
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    cwd: path.resolve(__dirname, ".."),
  });

  git(["checkout", localBranch], { plain: true });
  git(["checkout", "HEAD", "--", "."], { plain: true });
  if (stashed) git(["stash", "pop"], { safe: true, plain: true });

  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    die("Local sync failed.");
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
git(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist. Run shadow-setup.ts first.`);
}

// Check if latest shadow is merged into work branch (HEAD's ancestor)
if (!git(["merge-base", "--is-ancestor", shadowRef, "HEAD"], { safe: true }).ok) {
  console.error(`\u2718 '${shadowRef}' has commits not merged into your local branch.\n`);
  console.error(`Merge them first:`);
  console.error(`  git fetch ${pushOrigin}`);
  console.error(`  git merge ${shadowRef}\n`);
  console.error(`Then re-run the export.`);
  process.exit(1);
}

// ── Build tree using temp index ───────────────────────────────────────────────
// Instead of a worktree + merge + cleanup, we use git plumbing:
// read only the subtrees we want into a temp index, write a tree, and
// create a merge commit with commit-tree. No files touch disk.

const headCommit = git(["rev-parse", "HEAD"]);
const shadowTip  = git(["rev-parse", shadowRef]);
const tmpIndex   = path.join(os.tmpdir(), `shadow-export-idx-${Date.now()}`);

console.log(`Building export tree from ${localBranch} (${headCommit.slice(0, 10)})...`);

process.env.GIT_INDEX_FILE = tmpIndex;
try {
  // Read only the subtrees we want from HEAD
  git(["read-tree", "--empty"]);
  git(["read-tree", `--prefix=${dir}/`, `HEAD:${dir}`]);
  git(["read-tree", `--prefix=.github/`, "HEAD:.github"], { safe: true });
  git(["read-tree", `--prefix=shadow/`, "HEAD:shadow"], { safe: true });

  // Remove shadowignored files
  if (ignorePatterns.length > 0) {
    const compiled = ignorePatterns.map(globToRegex);
    const dirFiles = git(["ls-files", "--", `${dir}/`]).split("\n").filter(Boolean);
    const ignoredFiles = dirFiles.filter(f => compiled.some(re => re.test(f.slice(dir.length + 1))));
    for (let i = 0; i < ignoredFiles.length; i += 100) {
      git(["rm", "--cached", "-f", "--", ...ignoredFiles.slice(i, i + 100)], { safe: true });
    }
  }

  const tree = git(["write-tree"]);

  // Check if anything changed compared to the shadow branch
  const shadowTree = git(["rev-parse", `${shadowRef}^{tree}`]);
  if (tree === shadowTree) {
    console.log("No changes to export — shadow branch is already up to date.");
    process.exit(0);
  }

  // Show what changed
  console.log("\nChanges to export:");
  spawnSync("git", ["diff-tree", "--stat", shadowTree, tree], { stdio: "inherit" });
  console.log();

  if (dryRun) {
    console.log("[DRY RUN] No changes were exported.");
    process.exit(0);
  }

  // Generate a readable commit message if none provided.
  // Lists the subjects of commits since the last export that touched dir/.
  const message = commitMsg ?? (() => {
    const subjects = git(["log", "--format=%s", `${shadowTip}..HEAD`, "--", `${dir}/`], { safe: true })
      .stdout.split("\n").filter(Boolean);
    return subjects.length > 0
      ? `Export ${dir}/ (${subjects.length} commit${subjects.length > 1 ? "s" : ""})\n\n${subjects.map((s: string) => `- ${s}`).join("\n")}`
      : `Export ${dir}/`;
  })();

  // Create merge commit (two parents: shadow tip + HEAD)
  // Add trailer so the forward workflow knows this push should be forwarded
  const finalMessage = appendTrailer(message, "Shadow-export: true");
  const newCommit = git(["commit-tree", tree, "-p", shadowTip, "-p", headCommit, "-m", finalMessage]);

  // Push
  console.log(`Pushing to ${pushOrigin}/${shadowBranch}...`);
  const pushResult = git(["push", pushOrigin, `${newCommit}:refs/heads/${shadowBranch}`], { safe: true });
  if (!pushResult.ok) {
    console.error(pushResult.stderr);
    die(`Push failed. Run 'git fetch ${pushOrigin} && git merge ${shadowRef}' then re-run the export.`);
  }
} finally {
  delete process.env.GIT_INDEX_FILE;
  fs.rmSync(tmpIndex, { force: true });
}

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
