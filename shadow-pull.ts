#!/usr/bin/env ts-node
/**
 * shadow-pull.ts — Safely merge shadow branch changes into your local branch.
 *
 * A plain `git merge origin/shadow/{dir}/main` would delete all non-dir/
 * files because the shadow branch's tree only contains dir/ files. This
 * script does the merge but restores non-dir/ files from HEAD afterward,
 * so only dir/ content is affected.
 *
 * Usage:
 *   npx tsx shadow-pull.ts
 *   npx tsx shadow-pull.ts -r frontend
 */
import { parseArgs } from "util";
import {
  REMOTES,
  run, runSafe, refExists,
  getCurrentBranch, shadowBranchName,
  validateName, die,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote: { type: "string", short: "r" },
    dir:    { type: "string", short: "d" },
    branch: { type: "string", short: "b" },
    help:   { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b branch]");
  console.log("  -r  Remote name                          (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory                   (default: inferred from remote config)");
  console.log("  -b  Branch                               (default: your current branch)");
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

// Refuse if working tree is dirty
if (!runSafe(["diff", "--quiet"]).ok || !runSafe(["diff", "--cached", "--quiet"]).ok) {
  die("Working tree has uncommitted changes. Commit or stash them first.");
}

console.log(`Fetching latest from ${pushOrigin}...`);
run(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist.`);
}

// Check if shadow is already merged (nothing to do)
if (runSafe(["merge-base", "--is-ancestor", shadowRef, "HEAD"]).ok) {
  console.log("Already up to date — shadow branch is fully merged into your local branch.");
  process.exit(0);
}

console.log(`Merging ${shadowRef} into ${localBranch}...`);

// Merge shadow, but don't commit yet — we need to restore non-dir/ files
const mergeResult = runSafe(["merge", "--no-commit", "--no-ff", shadowRef]);

if (!mergeResult.ok && !runSafe(["rev-parse", "MERGE_HEAD"]).ok) {
  console.error(mergeResult.stderr);
  die("Merge failed.");
}

// The merge "deleted" all non-dir/ files because shadow's tree only has dir/.
// Restore them from HEAD (which is still the pre-merge main).
const headFiles = run(["ls-tree", "-r", "--name-only", "HEAD"])
  .split("\n").filter(Boolean);
const nonDirFiles = headFiles.filter(f => !f.startsWith(`${dir}/`));

if (nonDirFiles.length > 0) {
  console.log(`Restoring ${nonDirFiles.length} file(s) outside '${dir}/'...`);
  for (let i = 0; i < nonDirFiles.length; i += 100) {
    run(["checkout", "HEAD", "--", ...nonDirFiles.slice(i, i + 100)]);
  }
}

// Commit the merge — even if there are no content changes, the merge
// ancestry must be recorded so the export pre-flight check passes.
run(["commit", "--no-edit", "--allow-empty"]);

console.log(`\n\u2713 Done. Merged ${shadowRef} into ${localBranch} (only '${dir}/' was affected).`);
