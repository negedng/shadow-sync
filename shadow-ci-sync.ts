#!/usr/bin/env ts-node
/**
 * shadow-ci-sync.ts — GitHub Actions entrypoint for shadow sync (pull).
 *
 * For each configured remote, fetches from the external repo and replays
 * new commits into shadow/{dir}/{branch} branches, then pushes them to origin.
 *
 * Remote URLs are resolved from environment variables:
 *   SHADOW_REMOTE_{NAME}_URL  (e.g. SHADOW_REMOTE_BACKEND_URL)
 *
 * Intended to run in CI (GitHub Actions) where:
 *   - The repo is checked out with full history (fetch-depth: 0)
 *   - Concurrency is managed by the workflow's concurrency group
 */
import {
  REMOTES,
  run, runSafe, refExists, listTeamBranches,
  resolveRemoteUrl, shadowBranchName,
  replayCommits, preflightChecks, handlePreflightResults,
  validateName,
} from "./shadow-common";

let failed = 0;

for (const { remote, dir, url } of REMOTES) {
  validateName(remote, "Remote name");
  validateName(dir, "Directory");

  // 1. Resolve URL from env var (or config fallback)
  const resolvedUrl = resolveRemoteUrl(remote, url);
  if (!resolvedUrl) {
    const envKey = `SHADOW_REMOTE_${remote.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
    console.error(`⚠ No URL for remote '${remote}'. Set ${envKey} or add url to shadow-config.json. Skipping.`);
    continue;
  }

  // 2. Add or update the git remote
  const existing = runSafe(["remote", "get-url", remote]);
  if (!existing.ok) {
    run(["remote", "add", remote, resolvedUrl]);
  } else if (existing.stdout !== resolvedUrl) {
    run(["remote", "set-url", remote, resolvedUrl]);
  }

  // 3. Fetch from external remote
  console.log(`\n══ Fetching from '${remote}' ══`);
  run(["fetch", remote]);

  // 4. Process each branch on the remote
  const branches = listTeamBranches(remote);
  if (branches.length === 0) {
    console.log(`  No branches found on '${remote}'.`);
    continue;
  }

  for (const branch of branches) {
    const teamRef = `${remote}/${branch}`;
    const shadow = shadowBranchName(dir, branch);

    console.log(`\n── ${teamRef} → ${shadow} ──`);

    // Pre-flight checks
    const warnings = preflightChecks(remote, teamRef);
    if (!handlePreflightResults(warnings)) {
      console.error(`  Skipping ${teamRef} due to preflight errors.`);
      failed++;
      continue;
    }

    // Check out the shadow branch (from origin if it exists, or create new)
    if (refExists(`origin/${shadow}`)) {
      run(["checkout", "-B", shadow, `origin/${shadow}`]);
    } else {
      // Create orphan-like shadow branch from current HEAD
      run(["checkout", "-b", shadow]);
    }

    // Run the per-commit replay
    try {
      const result = replayCommits({ remote, dir, teamBranch: branch });

      if (!result.upToDate) {
        console.log(`  Pushing ${result.mirrored} new commit(s) to origin/${shadow}...`);
        run(["push", "origin", `${shadow}:${shadow}`]);
        console.log(`  ✓ Pushed.`);
      } else {
        console.log(`  ${shadow} is up to date.`);
      }
    } catch (err: any) {
      console.error(`  ✘ Failed to replay ${teamRef}: ${err.message}`);
      failed++;
      // Reset any partial state before moving to next branch
      runSafe(["reset", "--hard"]);
    }

    // Return to detached HEAD so we can check out the next shadow branch
    runSafe(["checkout", "--detach"]);
  }
}

if (failed > 0) {
  console.error(`\n${failed} sync(s) failed.`);
  process.exit(1);
}

console.log("\n✓ All syncs completed successfully.");
