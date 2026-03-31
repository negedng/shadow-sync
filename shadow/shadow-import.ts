#!/usr/bin/env ts-node
/**
 * shadow-import.ts — Import external changes into your local branch.
 *
 * 1. Runs ci-sync locally to fetch and replay external commits into the shadow branch.
 *    Skipped with --no-sync.
 * 2. Safely merges the shadow branch into your local branch, resetting the
 *    index to HEAD and overlaying only dir/ changes so nothing else is affected.
 *
 * Usage:
 *   npx tsx shadow-import.ts
 *   npx tsx shadow-import.ts -r frontend
 *   npx tsx shadow-import.ts --no-sync
 */
import * as path from "path";
import { spawnSync } from "child_process";
import { parseArgs } from "util";
import {
  REMOTES,
  git, refExists,
  getCurrentBranch, shadowBranchName,
  validateName, die,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote:    { type: "string",  short: "r" },
    dir:       { type: "string",  short: "d" },
    branch:    { type: "string",  short: "b" },
    "no-sync": { type: "boolean" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-import.ts [-r remote] [-d dir] [-b branch] [--no-sync]");
  console.log("  -r         Remote name                          (default: first entry in REMOTES)");
  console.log("  -d         Local subdirectory                   (default: inferred from remote config)");
  console.log("  -b         Branch                               (default: your current branch)");
  console.log("  --no-sync  Skip triggering CI sync");
  process.exit(0);
}

const localBranch = getCurrentBranch();
const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  die(`Remote '${values.remote}' not found in REMOTES. Add it to shadow-config.json.`);
}

const remote = values.remote ?? remoteEntry!.remote;
const dir    = values.dir    ?? remoteEntry!.dir;
const externalBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");

const pushOrigin   = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowBranch = shadowBranchName(dir, externalBranch);
const shadowRef    = `${pushOrigin}/${shadowBranch}`;

// Refuse if working tree is dirty (use plain git to respect repo's autocrlf setting)
if (!git(["diff", "--quiet"], { safe: true, plain: true }).ok || !git(["diff", "--cached", "--quiet"], { safe: true, plain: true }).ok) {
  die("Working tree has uncommitted changes. Commit or stash them first.");
}

// ── Run local sync ────────────────────────────────────────────────────────────

if (!values["no-sync"]) {
  console.log("Running local sync (fetching external changes)...");

  // ci-sync checks out shadow branches, which modifies the working tree and
  // detaches HEAD. Stash any untracked files so checkout doesn't fail, then
  // restore everything after.
  const stashed = git(["stash", "push", "-u", "-m", "shadow-import: pre-sync stash"], { safe: true, plain: true }).ok;

  const ciSyncPath = path.join(__dirname, "shadow-ci-sync.ts");
  const tsxPath = require.resolve("tsx/cli");
  const result = spawnSync(process.execPath, [tsxPath, ciSyncPath, "-r", remote], {
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    cwd: path.resolve(__dirname, ".."),
  });

  // Restore the original branch and working tree.
  // Use checkout -f to force-restore files deleted by ci-sync's branch switching.
  git(["checkout", "-f", localBranch], { plain: true });
  if (stashed) git(["stash", "pop"], { safe: true, plain: true });

  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    die("Local sync failed.");
  }
}

// ── Fetch and merge ───────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
git(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist.`);
}

if (git(["merge-base", "--is-ancestor", shadowRef, "HEAD"], { safe: true }).ok) {
  console.log("Already up to date — shadow branch is fully merged into your local branch.");
  process.exit(0);
}

console.log(`Merging ${shadowRef} into ${localBranch}...`);

// Use plain git (no autocrlf override) for working-tree operations on Windows
const mergeResult = git(["merge", "--no-commit", "--no-ff", shadowRef], { safe: true, plain: true });

if (!mergeResult.ok && !git(["rev-parse", "MERGE_HEAD"], { safe: true, plain: true }).ok) {
  console.error(mergeResult.stderr);
  die("Merge failed.");
}

// Undo merge changes for files outside dir/ — only dir/ should be affected.
// Get list of files changed by the merge outside the target directory.
const changedFiles = git(["diff", "--cached", "--name-only", "HEAD"], { safe: true, plain: true });
if (changedFiles.ok && changedFiles.stdout) {
  const outsideFiles = changedFiles.stdout.split("\n").filter(f => f && !f.startsWith(`${dir}/`));
  if (outsideFiles.length > 0) {
    // Restore non-dir files back to HEAD state
    git(["checkout", "HEAD", "--", ...outsideFiles], { plain: true });
  }
}

// Check if there are merge conflicts in dir/
const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { safe: true, plain: true });
if (conflicts.ok && conflicts.stdout) {
  const dirConflicts = conflicts.stdout.split("\n").filter(f => f && f.startsWith(`${dir}/`));
  if (dirConflicts.length > 0) {
    console.log(`\n⚠ Merge conflicts in ${dir}/:\n`);
    for (const f of dirConflicts) {
      console.log(`  ${f}`);
    }
    console.log(`\nResolve conflicts, then run: git add <files> && git commit --no-edit`);
    process.exit(1);
  }
}

git(["commit", "--no-edit", "--allow-empty"], { plain: true });

console.log(`\n\u2713 Done. Merged ${shadowRef} into ${localBranch} (only '${dir}/' was affected).`);
