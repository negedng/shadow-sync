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
  replayCommitsIncoming, preflightChecks, handlePreflightResults,
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

  // Add or update the git remote
  const existing = git(["remote", "get-url", remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", remote, url]);
  } else if (existing.stdout !== url) {
    git(["remote", "set-url", remote, url]);
  }

  // Fetch from external remote
  console.log(`\n══ Fetching from '${remote}' ══`);
  git(["fetch", remote]);

  // Process each branch on the remote
  const branches = listExternalBranches(remote);
  if (branches.length === 0) {
    console.log(`  No branches found on '${remote}'.`);
    continue;
  }

  // Pre-flight checks — collect branches that pass
  const validBranches: string[] = [];
  for (const branch of branches) {
    const externalRef = `${remote}/${branch}`;
    console.log(`\n── Preflight: ${externalRef} ──`);
    const warnings = preflightChecks(externalRef);
    if (handlePreflightResults(warnings)) {
      validBranches.push(branch);
    } else {
      console.error(`  Skipping ${externalRef} due to preflight errors.`);
      failed++;
    }
  }

  if (validBranches.length === 0) continue;

  // Replay all commits across all branches in topological order.
  // This preserves shared ancestors so shadow branches have correct DAG topology.
  try {
    console.log(`\n── Replaying commits for ${remote} (${validBranches.length} branch(es)) ──`);
    const result = replayCommitsIncoming({ remote, dir, branches: validBranches });

    // Update each shadow branch ref and push
    for (const branch of validBranches) {
      const shadow = shadowBranchName(dir, branch);
      const localSHA = result.branchMapping.get(branch);

      if (!localSHA) {
        console.log(`  ${shadow}: no mapping found, skipping.`);
        continue;
      }

      // Check if update is needed
      const currentSHA = refExists(`origin/${shadow}`)
        ? git(["rev-parse", `origin/${shadow}`])
        : null;

      if (currentSHA === localSHA) {
        console.log(`  ${shadow} is up to date.`);
        continue;
      }

      if (currentSHA) {
        // If our sync tip is already an ancestor of origin (e.g. export added
        // commits on top), origin is ahead — nothing to push.
        const isAncestor = git(
          ["merge-base", "--is-ancestor", localSHA, currentSHA], { safe: true },
        ).ok;
        if (isAncestor) {
          console.log(`  ${shadow} is up to date (origin is ahead or equal).`);
          continue;
        }

        // Detect tree-only changes (all forwarded commits produce same tree)
        const oldTree = git(["rev-parse", `${currentSHA}^{tree}`]);
        const newTree = git(["rev-parse", `${localSHA}^{tree}`]);
        if (oldTree === newTree) {
          console.log(`  ${shadow}: no tree changes (all forwarded). Skipping push.`);
          continue;
        }
      }

      // Check if push would be fast-forward
      let pushSHA = localSHA;
      if (currentSHA) {
        const isFF = git(
          ["merge-base", "--is-ancestor", currentSHA, localSHA], { safe: true },
        ).ok;
        if (!isFF) {
          // Origin has diverged (e.g. export added merge commits on top).
          // Create a merge commit that uses the synced commit's tree — it has
          // the full repo tree with the correct dir/ content. The export commit's
          // tree is partial (only dir/ + .github/ + shadow/) so we don't try a
          // 3-way merge which would conflict on files outside dir/.
          console.log(`  ${shadow}: origin diverged, creating merge to reconcile...`);
          const syncedTree = git(["rev-parse", `${localSHA}^{tree}`]);
          pushSHA = git([
            "commit-tree", syncedTree,
            "-p", currentSHA, "-p", localSHA,
            "-m", `Merge synced commits into ${shadow}`,
          ]);
        }
      }

      // Point shadow branch at the (possibly merged) commit and push
      git(["update-ref", `refs/heads/${shadow}`, pushSHA]);
      console.log(`  Pushing to origin/${shadow}...`);
      git(["push", "origin", `${shadow}:${shadow}`]);
      console.log(`  ✓ Pushed.`);
    }
  } catch (err: any) {
    console.error(`  ✘ Failed to replay for ${remote}: ${err.message}`);
    failed++;
  }

  // Detect stale shadow branches (remote branch was deleted but shadow/ remains)
  const shadowPrefix = `origin/${shadowBranchName(dir, "")}`;
  const allShadow = git(["branch", "-r"])
    .split("\n").map(l => l.trim())
    .filter(l => l.startsWith(shadowPrefix));
  const activeBranches = new Set(branches.map(b => `origin/${shadowBranchName(dir, b)}`));
  const stale = allShadow.filter(s => !activeBranches.has(s));
  if (stale.length > 0) {
    console.log(`\n⚠ Stale shadow branches (remote branch deleted from '${remote}'):`);
    for (const s of stale) {
      console.log(`  ${s}  →  git push origin --delete ${s.replace("origin/", "")}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} sync(s) failed.`);
  process.exit(1);
}

console.log("\n✓ All syncs completed successfully.");
