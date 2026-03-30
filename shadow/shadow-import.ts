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
  run, runPlain, runSafe, runSafePlain, refExists,
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
if (!runSafePlain(["diff", "--quiet"]).ok || !runSafePlain(["diff", "--cached", "--quiet"]).ok) {
  die("Working tree has uncommitted changes. Commit or stash them first.");
}

// ── Run local sync ────────────────────────────────────────────────────────────

if (!values["no-sync"]) {
  console.log("Running local sync (fetching external changes)...");

  // ci-sync checks out shadow branches, which modifies the working tree and
  // detaches HEAD. Stash any untracked files so checkout doesn't fail, then
  // restore everything after.
  const stashed = runSafePlain(["stash", "push", "-u", "-m", "shadow-import: pre-sync stash"]).ok;

  const ciSyncPath = path.join(__dirname, "shadow-ci-sync.ts");
  const tsxPath = require.resolve("tsx/cli");
  const result = spawnSync(process.execPath, [tsxPath, ciSyncPath], {
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    cwd: path.resolve(__dirname, ".."),
  });

  // Restore the original branch and working tree
  runPlain(["checkout", localBranch]);
  runPlain(["checkout", "HEAD", "--", "."]);
  if (stashed) runSafePlain(["stash", "pop"]);

  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    die("Local sync failed.");
  }
}

// ── Fetch and merge ───────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
run(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist.`);
}

if (runSafe(["merge-base", "--is-ancestor", shadowRef, "HEAD"]).ok) {
  console.log("Already up to date — shadow branch is fully merged into your local branch.");
  process.exit(0);
}

console.log(`Merging ${shadowRef} into ${localBranch}...`);

// Use plain git (no autocrlf override) for working-tree operations on Windows
const mergeResult = runSafePlain(["merge", "--no-commit", "--no-ff", shadowRef]);

if (!mergeResult.ok && !runSafePlain(["rev-parse", "MERGE_HEAD"]).ok) {
  console.error(mergeResult.stderr);
  die("Merge failed.");
}

// Reset index to HEAD (undoes merge effect on all files), then overlay
// only dir/ from the shadow branch. MERGE_HEAD is preserved.
runPlain(["read-tree", "HEAD"]);
runPlain(["checkout", shadowRef, "--", `${dir}/`]);
runPlain(["commit", "--no-edit", "--allow-empty"]);

console.log(`\n\u2713 Done. Merged ${shadowRef} into ${localBranch} (only '${dir}/' was affected).`);
