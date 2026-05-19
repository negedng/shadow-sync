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
  PAIRS, ShadowSyncError,
  git, refExists, listRemoteBranches,
  shadowBranchName, ensureRemote,
  mirrorHistory, syncTags, runPreflightChecks, printPreflightResults,
  validateName, fail,
} from "./shadow-common";

// ── Exported sync function (used by tests in-process) ────────────────────────

export interface SyncOptions {
  pair?: string;
  from?: "a" | "b";
  branch?: string;
  /** Operator-supplied target-merge SHA(s) for B' disambiguation (see findResolutionCandidate). */
  using?: string[];
}

export interface SyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runSync(options: SyncOptions = {}): SyncResult {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origLog = console.log;
  const origErr = console.error;

  console.log = (...args: unknown[]) => stdoutBuf.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderrBuf.push(args.map(String).join(" "));

  try {
    const exitCode = _runSyncCore(options);
    return { exitCode, stdout: stdoutBuf.join("\n"), stderr: stderrBuf.join("\n") };
  } catch (e) {
    if (e instanceof ShadowSyncError) {
      stderrBuf.push(e.message);
      return { exitCode: 1, stdout: stdoutBuf.join("\n"), stderr: stderrBuf.join("\n") };
    }
    throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function _runSyncCore(options: SyncOptions): number {
  const pairName = options.pair;
  const pairsToSync = pairName
    ? PAIRS.filter(p => p.name === pairName)
    : PAIRS;

  if (pairName && pairsToSync.length === 0) {
    fail(`Pair '${pairName}' not found in config.`);
  }

  const fromSide = (options.from ?? "b") as "a" | "b";
  if (fromSide !== "a" && fromSide !== "b") {
    fail(`--from must be "a" or "b", got "${options.from}".`);
  }

  let failed = 0;

  for (const pair of pairsToSync) {
    const source = fromSide === "a" ? pair.a : pair.b;
    const target = fromSide === "a" ? pair.b : pair.a;
    validateName(pair.name, "Pair name");
    validateName(source.remote, "Source remote");
    validateName(target.remote, "Target remote");
    if (options.branch) validateName(options.branch, "Branch");

    ensureRemote(pair.a);
    ensureRemote(pair.b);

    // Fetch both remotes before replay. Target-side objects (fallback parent,
    // existing shadow branches for the dedup scan) must exist locally for the
    // replay loop to resolve SHA mappings and build trees. A fresh CI runner
    // has neither cached, so both fetches are mandatory up front.
    console.log(`\n══ Syncing pair '${pair.name}' (from ${fromSide}: ${source.remote} → ${target.remote}) ══`);
    git(["fetch", source.remote]);
    const targetFetchEarly = git(["fetch", target.remote], { safe: true });
    if (!targetFetchEarly.ok) {
      console.error(`  ⚠ Failed to fetch '${target.remote}': ${targetFetchEarly.stderr}`);
      console.error(`    Continuing with local tracking refs — divergence checks may be stale.`);
    }

    const branches = options.branch
      ? [options.branch]
      : listRemoteBranches(source.remote);

    if (branches.length === 0) {
      console.log(`  No branches found on '${source.remote}'.`);
      continue;
    }

    // Pre-flight checks on source branches
    const validBranches: string[] = [];
    for (const branch of branches) {
      const ref = `${source.remote}/${branch}`;
      if (!refExists(ref)) {
        console.error(`  Branch '${ref}' does not exist, skipping.`);
        continue;
      }
      console.log(`\n── Preflight: ${ref} ──`);
      const warnings = runPreflightChecks(ref);
      if (printPreflightResults(warnings)) {
        validBranches.push(branch);
      } else {
        console.error(`  Skipping ${ref} due to preflight errors.`);
        failed++;
      }
    }

    if (validBranches.length === 0) continue;

    try {
      console.log(`\n── Replaying commits for ${pair.name} (${validBranches.length} branch(es)) ──`);
      const result = mirrorHistory({
        pair,
        from: fromSide,
        branches: validBranches,
        using: options.using ?? [],
      });

      // Update shadow branches on target's remote
      for (const branch of validBranches) {
        const shadow = shadowBranchName(pair.name, branch);
        const replayedSHA = result.branchMapping.get(branch);

        if (!replayedSHA) {
          console.log(result.upToDate
            ? `  ${shadow}: already up to date.`
            : `  ${shadow}: no mapping found, skipping.`);
          continue;
        }

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
        }

        // Fast-forward only on shadow refs (C6). If the divergent target
        // tip has the same TREE as the replay (residual sibling-merge case
        // --full-history doesn't cover), leave it in place. If the trees
        // differ, halt — this only happens after source rewrite or manual
        // edits to the shadow ref, both against policy.
        if (currentSHA) {
          const isFF = git(
            ["merge-base", "--is-ancestor", currentSHA, replayedSHA], { safe: true },
          ).ok;
          if (!isFF) {
            const currentTree = git(["rev-parse", `${currentSHA}^{tree}`]);
            const replayedTree = git(["rev-parse", `${replayedSHA}^{tree}`]);
            if (currentTree === replayedTree) {
              console.log(`  ${shadow}: ${target.remote} has same tree on different topology; leaving target tip in place.`);
              continue;
            }
            fail(`${shadow}: ${target.remote} diverged with different tree. ` +
                 `Engine cannot fast-forward and force-push is disabled. ` +
                 `Source main may have been rewritten or the shadow ref was edited manually. ` +
                 `Operator must reconcile by either restoring the expected source history or ` +
                 `manually pushing ${replayedSHA} to ${target.remote}/${shadow}.`);
          }
        }

        console.log(`  Pushing to ${target.remote}/${shadow}...`);
        git(["push", target.remote, `${replayedSHA}:refs/heads/${shadow}`]);
        console.log(`  ✓ Pushed.`);
      }

      // Tag sync runs in both directions: tags on the source side get
      // recreated on the target pointing at the replayed commit. Annotated
      // tags get a fresh tag object (same name/tagger/message); lightweight
      // tags become refs/tags/<name> pointing at the replay. Tags whose
      // source commit was dropped (no shaMapping entry) are skipped.
      syncTags({ source, target, shaMapping: result.shaMapping });
    } catch (err: any) {
      console.error(`  ✘ Failed to sync ${pair.name}: ${err.message}`);
      failed++;
    }

    // Detect stale shadow branches (only when syncing all branches from a remote)
    if (!options.branch) {
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
    return 1;
  }

  console.log("\n✓ All syncs completed successfully.");
  return 0;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      pair:   { type: "string", short: "p" },
      remote: { type: "string", short: "r" },  // alias for --pair
      from:   { type: "string", short: "f" },
      branch: { type: "string", short: "b" },
      using:  { type: "string", multiple: true },
    },
    strict: true,
  });

  const result = runSync({
    pair: values.pair ?? values.remote,
    from: (values.from ?? "b") as "a" | "b",
    branch: values.branch,
    using: values.using,
  });

  if (result.stdout) process.stdout.write(result.stdout + "\n");
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}
