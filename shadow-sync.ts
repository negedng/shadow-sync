#!/usr/bin/env ts-node
/**
 * shadow-sync.ts — Replay commits between two repos in a pair.
 *
 * Direction is specified with --from: which side's commits to replay.
 *   --from b: replay b's commits into shadow branches on a's remote
 *   --from a: replay a's commits into shadow branches on b's remote
 *
 * Usage:
 *   npx tsx shadow-sync.ts --pair backend --from b          # pull from b → a
 *   npx tsx shadow-sync.ts --pair backend --from a          # push from a → b
 *   npx tsx shadow-sync.ts --pair backend --from a -b main  # push specific branch
 */
import { parseArgs } from "util";
import {
  PAIRS,
  git, refExists, listBranches, getCurrentBranch,
  shadowBranchName, ensureRemote,
  replayCommits, preflightChecks, handlePreflightResults,
  validateName, die,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    pair:   { type: "string", short: "p" },
    remote: { type: "string", short: "r" },  // alias for --pair
    from:   { type: "string", short: "f" },
    branch: { type: "string", short: "b" },
  },
  strict: true,
});

const pairName = values.pair ?? values.remote;
const pairsToSync = pairName
  ? PAIRS.filter(p => p.name === pairName)
  : PAIRS;

if (pairName && pairsToSync.length === 0) {
  die(`Pair '${pairName}' not found in config.`);
}

const fromSide = (values.from ?? "b") as "a" | "b";
if (fromSide !== "a" && fromSide !== "b") {
  die(`--from must be "a" or "b", got "${values.from}".`);
}

let failed = 0;

for (const pair of pairsToSync) {
  const source = fromSide === "a" ? pair.a : pair.b;
  const target = fromSide === "a" ? pair.b : pair.a;
  validateName(pair.name, "Pair name");
  validateName(source.remote, "Source remote");
  validateName(target.remote, "Target remote");

  ensureRemote(pair.a);
  ensureRemote(pair.b);

  // Fetch from source
  console.log(`\n══ Syncing pair '${pair.name}' (from ${fromSide}: ${source.remote} → ${target.remote}) ══`);
  git(["fetch", source.remote]);

  // Determine branches to replay.
  // If source has no url, it's the workspace — default to current branch.
  // If source has a url, it's a remote — list all its branches.
  let branches: string[];
  let sourceBranch: string | undefined;

  if (values.branch) {
    branches = [values.branch];
    sourceBranch = values.branch;
  } else if (!source.url) {
    // Source is the workspace — use current branch
    const current = getCurrentBranch();
    sourceBranch = current;
    branches = [current];
  } else {
    // Source is a remote — list all branches
    branches = listBranches(source.remote);
  }

  if (branches.length === 0) {
    console.log(`  No branches found on '${source.remote}'.`);
    continue;
  }

  // Pre-flight checks on source branches
  const validBranches: string[] = [];
  for (const branch of branches) {
    const ref = sourceBranch ? branch : `${source.remote}/${branch}`;
    if (!refExists(ref)) {
      console.error(`  Branch '${ref}' does not exist, skipping.`);
      continue;
    }
    console.log(`\n── Preflight: ${ref} ──`);
    const warnings = preflightChecks(ref);
    if (handlePreflightResults(warnings)) {
      validBranches.push(branch);
    } else {
      console.error(`  Skipping ${ref} due to preflight errors.`);
      failed++;
    }
  }

  if (validBranches.length === 0) continue;

  // Check for uncommitted changes when replaying from workspace branches
  if (sourceBranch && source.dir) {
    const dirty = !git(["diff", "--cached", "--quiet", "--", `${source.dir}/`], { safe: true, plain: true }).ok
      || !git(["diff", "--quiet", "HEAD", "--", `${source.dir}/`], { safe: true, plain: true }).ok;
    if (dirty) {
      die(`'${source.dir}/' has uncommitted changes. Commit or stash them first.`);
    }
  }

  try {
    console.log(`\n── Replaying commits for ${pair.name} (${validBranches.length} branch(es)) ──`);
    const result = replayCommits({
      pair,
      from: fromSide,
      branches: validBranches,
      sourceBranch,
    });

    if (result.upToDate && !sourceBranch) {
      console.log("  Already up to date.");
      continue;
    }

    // Fetch target to know current state
    git(["fetch", target.remote], { safe: true });

    // Update shadow branches on target's remote
    for (const branch of validBranches) {
      const shadow = shadowBranchName(pair.name, branch);
      const replayedSHA = result.branchMapping.get(branch);

      if (!replayedSHA) {
        if (result.upToDate) {
          console.log(`  Already up to date.`);
        } else {
          console.log(`  ${shadow}: no mapping found, skipping.`);
        }
        continue;
      }

      // Check if update is needed
      const currentSHA = refExists(`${target.remote}/${shadow}`)
        ? git(["rev-parse", `${target.remote}/${shadow}`])
        : null;

      if (currentSHA === replayedSHA) {
        console.log(`  ${shadow} is up to date.`);
        continue;
      }

      if (currentSHA) {
        const isAncestor = git(
          ["merge-base", "--is-ancestor", replayedSHA, currentSHA], { safe: true },
        ).ok;
        if (isAncestor) {
          console.log(`  ${shadow} is up to date (${target.remote} is ahead or equal).`);
          continue;
        }

        // Detect tree-only changes
        const oldTree = git(["rev-parse", `${currentSHA}^{tree}`]);
        const newTree = git(["rev-parse", `${replayedSHA}^{tree}`]);
        if (oldTree === newTree) {
          console.log(`  ${shadow}: no tree changes. Skipping push.`);
          continue;
        }
      }

      // Check fast-forward, create merge if diverged
      let pushSHA = replayedSHA;
      if (currentSHA) {
        const isFF = git(
          ["merge-base", "--is-ancestor", currentSHA, replayedSHA], { safe: true },
        ).ok;
        if (!isFF) {
          console.log(`  ${shadow}: ${target.remote} diverged, creating merge to reconcile...`);
          const syncedTree = git(["rev-parse", `${replayedSHA}^{tree}`]);
          pushSHA = git([
            "commit-tree", syncedTree,
            "-p", currentSHA, "-p", replayedSHA,
            "-m", `Merge replayed commits into ${shadow}`,
          ]);
        }
      }

      console.log(`  Pushing to ${target.remote}/${shadow}...`);
      git(["push", target.remote, `${pushSHA}:refs/heads/${shadow}`]);
      console.log(`  ✓ Pushed.`);
    }
  } catch (err: any) {
    console.error(`  ✘ Failed to sync ${pair.name}: ${err.message}`);
    failed++;
  }

  // Detect stale shadow branches (only when syncing all branches from a remote)
  if (!sourceBranch) {
    const shadowPrefix = `${target.remote}/${shadowBranchName(pair.name, "")}`;
    const allShadow = git(["branch", "-r"])
      .split("\n").map(l => l.trim())
      .filter(l => l.startsWith(shadowPrefix));
    const activeBranches = new Set(branches.map(b => `${target.remote}/${shadowBranchName(pair.name, b)}`));
    const stale = allShadow.filter(s => !activeBranches.has(s));
    if (stale.length > 0) {
      console.log(`\n⚠ Stale shadow branches (branch deleted from '${source.remote}'):`);
      for (const s of stale) {
        console.log(`  ${s}  →  git push ${target.remote} --delete ${s.replace(`${target.remote}/`, "")}`);
      }
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} sync(s) failed.`);
  process.exit(1);
}

console.log("\n✓ All syncs completed successfully.");
