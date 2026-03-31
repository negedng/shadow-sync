#!/usr/bin/env ts-node
/**
 * shadow-ci-sync.ts — GitHub Actions entrypoint for shadow sync (pull).
 *
 * For each configured remote, fetches from the external repo and replays
 * new commits into shadow/{dir}/{branch} branches, then pushes them to origin.
 *
 * Intended to run in CI (GitHub Actions) where:
 *   - The repo is checked out with full history (fetch-depth: 0)
 *   - Concurrency is managed by the workflow's concurrency group
 */
import { parseArgs } from "util";
import {
  REMOTES,
  git, refExists, listExternalBranches,
  shadowBranchName,
  replayCommits, preflightChecks, handlePreflightResults,
  validateName,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote: { type: "string", short: "r" },
  },
  strict: true,
});

const remotesToSync = values.remote
  ? REMOTES.filter(r => r.remote === values.remote)
  : REMOTES;

if (values.remote && remotesToSync.length === 0) {
  console.error(`Remote '${values.remote}' not found in config.`);
  process.exit(1);
}

let failed = 0;

for (const { remote, dir, url } of remotesToSync) {
  validateName(remote, "Remote name");
  validateName(dir, "Directory");

  if (!url) {
    console.error(`⚠ No URL for remote '${remote}'. Add url to shadow-config.json. Skipping.`);
    continue;
  }

  // Add or update the git remote
  const existing = git(["remote", "get-url", remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", remote, url]);
  } else if (existing.stdout !== url) {
    git(["remote", "set-url", remote, url]);
  }

  // 3. Fetch from external remote
  console.log(`\n══ Fetching from '${remote}' ══`);
  git(["fetch", remote]);

  // 4. Process each branch on the remote
  const branches = listExternalBranches(remote);
  if (branches.length === 0) {
    console.log(`  No branches found on '${remote}'.`);
    continue;
  }

  for (const branch of branches) {
    const externalRef = `${remote}/${branch}`;
    const shadow = shadowBranchName(dir, branch);

    console.log(`\n── ${externalRef} → ${shadow} ──`);

    // Pre-flight checks
    const warnings = preflightChecks(externalRef);
    if (!handlePreflightResults(warnings)) {
      console.error(`  Skipping ${externalRef} due to preflight errors.`);
      failed++;
      continue;
    }

    // Check out the shadow branch (from origin if it exists, or create from main)
    if (refExists(`origin/${shadow}`)) {
      git(["checkout", "-B", shadow, `origin/${shadow}`]);
    } else {
      git(["checkout", "-B", shadow, "origin/main"]);
    }

    // Run the per-commit replay
    try {
      // Capture tree before replay to detect if anything actually changed
      const treeBefore = git(["rev-parse", "HEAD^{tree}"]);
      const result = replayCommits({ remote, dir, externalBranch: branch });
      const treeAfter = git(["rev-parse", "HEAD^{tree}"]);

      if (result.upToDate) {
        console.log(`  ${shadow} is up to date.`);
      } else if (treeBefore === treeAfter) {
        console.log(`  ${result.mirrored} commit(s) mirrored but no tree changes (all forwarded). Skipping push.`);
      } else {
        console.log(`  Pushing ${result.mirrored} new commit(s) to origin/${shadow}...`);
        git(["push", "origin", `${shadow}:${shadow}`]);
        console.log(`  ✓ Pushed.`);
      }
    } catch (err: any) {
      console.error(`  ✘ Failed to replay ${externalRef}: ${err.message}`);
      failed++;
      // Reset any partial state before moving to next branch
      git(["reset", "--hard"], { safe: true });
    }

    // Return to detached HEAD so we can check out the next shadow branch
    git(["checkout", "--detach"], { safe: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} sync(s) failed.`);
  process.exit(1);
}

console.log("\n✓ All syncs completed successfully.");
