#!/usr/bin/env ts-node
/**
 * shadow-pull.ts — Sync external changes and merge them into your local branch.
 *
 * 1. Triggers CI sync on GitHub (external → shadow) and waits for it.
 *    Requires EXTERNAL_REPO_TOKEN env var. Skipped if not set.
 * 2. Safely merges the shadow branch into your local branch, restoring
 *    non-dir/ files so only dir/ content is affected.
 *
 * Usage:
 *   npx tsx shadow-pull.ts
 *   npx tsx shadow-pull.ts -r frontend
 *   npx tsx shadow-pull.ts --no-sync
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
    remote:    { type: "string",  short: "r" },
    dir:       { type: "string",  short: "d" },
    branch:    { type: "string",  short: "b" },
    "no-sync": { type: "boolean" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b branch] [--no-sync]");
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

// Refuse if working tree is dirty
if (!runSafe(["diff", "--quiet"]).ok || !runSafe(["diff", "--cached", "--quiet"]).ok) {
  die("Working tree has uncommitted changes. Commit or stash them first.");
}

// ── Trigger CI sync ───────────────────────────────────────────────────────────

if (!values["no-sync"]) {
  const token = process.env.EXTERNAL_REPO_TOKEN;
  if (token) {
    const originUrl = run(["remote", "get-url", pushOrigin]);
    const m = originUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (m) {
      console.log(`Triggering CI sync on ${m[1]}/${m[2]}...`);
      const res = await fetch(
        `https://api.github.com/repos/${m[1]}/${m[2]}/actions/workflows/shadow-sync.yml/dispatches`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      if (res.status === 204) {
        console.log("Waiting for sync to complete...");
        await new Promise(r => setTimeout(r, 20000));
      } else {
        console.log(`Sync trigger failed (${res.status}), pulling current shadow state.`);
      }
    }
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

const mergeResult = runSafe(["merge", "--no-commit", "--no-ff", shadowRef]);

if (!mergeResult.ok && !runSafe(["rev-parse", "MERGE_HEAD"]).ok) {
  console.error(mergeResult.stderr);
  die("Merge failed.");
}

const headFiles = run(["ls-tree", "-r", "--name-only", "HEAD"])
  .split("\n").filter(Boolean);
const nonDirFiles = headFiles.filter(f => !f.startsWith(`${dir}/`));

if (nonDirFiles.length > 0) {
  console.log(`Restoring ${nonDirFiles.length} file(s) outside '${dir}/'...`);
  for (let i = 0; i < nonDirFiles.length; i += 100) {
    run(["checkout", "HEAD", "--", ...nonDirFiles.slice(i, i + 100)]);
  }
}

run(["commit", "--no-edit", "--allow-empty"]);

console.log(`\n\u2713 Done. Merged ${shadowRef} into ${localBranch} (only '${dir}/' was affected).`);
