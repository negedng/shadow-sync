#!/usr/bin/env tsx
/**
 * shadow-sync.ts — Replay commits between two repos in a pair.
 *
 * Direction is specified with --from: which side's commits to replay.
 *   --from b: replay b's commits into shadow branches on a's remote
 *   --from a: replay a's commits into shadow branches on b's remote
 * --from also accepts the config's side aliases (e.g. `"sides": {"a":"mono",
 * "b":"ext"}` lets `--from mono` / `--from ext` stand in for a / b).
 *
 * Usage:
 *   npx tsx shadow-sync.ts --pair backend --from b          # pull from b → a
 *   npx tsx shadow-sync.ts --pair backend --from a          # push from a → b
 *   npx tsx shadow-sync.ts --pair backend --from ext        # pull (b alias)
 *   npx tsx shadow-sync.ts --pair backend --from a -b main  # push specific branch
 *   npx tsx shadow-sync.ts --pair backend --from b -n       # dry run, push nothing
 */
import { parseArgs } from "util";
import {
  PAIRS, CONFIG_PATH, ShadowSyncError,
  git, refExists, listRemoteBranches, filterBranchesForRemote,
  shadowBranchName, ensureRemote,
  mirrorHistory, syncTags, runPreflightChecks, printPreflightResults,
  validateName, fail, resolveFromSide,
} from "./shadow-common";

// ── Exported sync function (used by tests in-process) ────────────────────────

export interface SyncOptions {
  pair?: string;
  /** "a" | "b", or a configured side alias (resolved via resolveFromSide). */
  from?: string;
  branch?: string;
  dryRun?: boolean;
  tags?: boolean;
  stream?: boolean;
  /** Override the >300-commits-per-sync safety limit. */
  allowManyCommits?: boolean;
  /** Override the >10MB-per-commit safety limit. */
  allowLargeCommits?: boolean;
  /** On shadow-ref divergence (rewritten source history), let the engine
   *  force-push the replay with --force-with-lease instead of failing closed. */
  allowShadowForce?: boolean;
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
  const stream = options.stream ?? false;

  console.log = (...args: unknown[]) => { const s = args.map(String).join(" "); stdoutBuf.push(s); if (stream) origLog(s); };
  console.error = (...args: unknown[]) => { const s = args.map(String).join(" "); stderrBuf.push(s); if (stream) origErr(s); };

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
  // Fail loud, not green: a missing/typo'd config would otherwise be a
  // permanent silent no-op "success".
  if (PAIRS.length === 0) {
    fail(`No pairs configured — config missing or empty at ${CONFIG_PATH}.`);
  }

  const pairName = options.pair;
  const pairsToSync = pairName
    ? PAIRS.filter(p => p.name === pairName)
    : PAIRS;

  if (pairName && pairsToSync.length === 0) {
    fail(`Pair '${pairName}' not found in config.`);
  }

  const fromSide = resolveFromSide(options.from);

  const dryRun = options.dryRun ?? false;
  if (dryRun) console.log("[DRY RUN] No branches or tags will be pushed.");

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

    // Both fetches are mandatory up front: target-side objects (fallback
    // parent, shadow refs for the dedup scan) must exist locally for replay.
    console.log(`\n══ Syncing pair '${pair.name}' (from ${fromSide}: ${source.remote} → ${target.remote}) ══`);
    // --prune: without it a branch deleted on the source keeps its stale
    // tracking ref and syncs forever (and stale-shadow detection never fires).
    const sourceFetch = git(["fetch", "--prune", source.remote], { safe: true });
    if (!sourceFetch.ok) {
      console.error(`  ✘ Failed to fetch '${source.remote}': ${sourceFetch.stderr}`);
      failed++;
      continue;
    }
    const targetFetchEarly = git(["fetch", "--prune", target.remote], { safe: true });
    if (!targetFetchEarly.ok) {
      console.error(`  ⚠ Failed to fetch '${target.remote}': ${targetFetchEarly.stderr}`);
      console.error(`    Continuing with local tracking refs — divergence checks may be stale.`);
    }

    if (options.branch) {
      console.log(`  ⚠ --branch ${options.branch}: bypassing the branch-filters.json allowlist.`);
    }
    const branches = options.branch
      ? [options.branch]
      : filterBranchesForRemote(source.remote, listRemoteBranches(source.remote));

    if (branches.length === 0) {
      console.log(`  No branches to sync on '${source.remote}' (after filter).`);
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
        allowManyCommits: options.allowManyCommits,
        allowLargeCommits: options.allowLargeCommits,
      });

      if (result.haltedBranches.length > 0) {
        console.error(`\n⚠ ${result.haltedBranches.length} branch(es) halted on ${pair.name}:`);
        for (const h of result.haltedBranches) {
          console.error(`\n── Halt on ${pair.name}/${h.branch ?? "<unknown>"} (${h.commitShort}) ──`);
          console.error(h.diagnostic);
        }
        failed++;
      }

      const branchFailures = pushShadowBranches({
        sourceLabel: source.label,
        sourceRemote: source.remote,
        targetRemote: target.remote,
        branches: validBranches,
        branchMapping: result.branchMapping,
        upToDate: result.upToDate,
        dryRun,
        allowShadowForce: options.allowShadowForce ?? false,
      });
      if (branchFailures > 0) {
        console.error(`  ✘ ${branchFailures} shadow branch update(s) failed on ${pair.name}.`);
        failed++;
      }

      // Tags on the source side are recreated on the target at the replayed commit.
      // Off by default; pass --tags to opt in.
      if (dryRun) {
        console.log(`\n[DRY RUN] Skipping tag sync.`);
      } else if (!options.tags) {
        console.log(`\nSkipping tag sync (pass --tags to enable).`);
      } else {
        const tagRes = syncTags({ source, target, syncedShaMap: result.syncedShaMap });
        if (tagRes.failed > 0) {
          console.error(`  ✘ ${tagRes.failed} tag push(es) failed on ${pair.name}.`);
          failed++;
        }
      }
    } catch (err: any) {
      console.error(`  ✘ Failed to sync ${pair.name}: ${err.message}`);
      failed++;
    }

    // Detect stale shadow branches (only when syncing all branches from a remote)
    if (!options.branch) {
      const shadowNamespace = `${target.remote}/${shadowBranchName(source.label, "")}`;
      const allShadow = git(["branch", "-r"])
        .split("\n").map(l => l.trim())
        .filter(l => l.startsWith(shadowNamespace));
      const activeBranches = new Set(branches.map(b => `${target.remote}/${shadowBranchName(source.label, b)}`));
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

/**
 * Push each branch's replayed tip to its shadow ref on the target remote.
 * Fast-forward only: a divergent target tip with the SAME tree is left in
 * place (residual sibling-merge case --full-history doesn't cover); a
 * different tree is reported as a failure — that only happens after a source
 * rewrite or a manual shadow-ref edit, both against policy. A failed branch
 * doesn't abort the others. Returns the failure count.
 */
function pushShadowBranches(opts: {
  sourceLabel: string;
  sourceRemote: string;
  targetRemote: string;
  branches: string[];
  branchMapping: Map<string, string>;
  upToDate: boolean;
  dryRun: boolean;
  allowShadowForce: boolean;
}): number {
  const { sourceLabel, sourceRemote, targetRemote, branches, branchMapping, upToDate, dryRun, allowShadowForce } = opts;
  let failures = 0;

  for (const branch of branches) {
    const shadow = shadowBranchName(sourceLabel, branch);
    const replayedSHA = branchMapping.get(branch);

    if (!replayedSHA) {
      console.log(upToDate
        ? `  ${shadow}: already up to date.`
        : `  ${shadow}: no mapping found, skipping.`);
      continue;
    }

    const currentSHA = refExists(`${targetRemote}/${shadow}`)
      ? git(["rev-parse", `${targetRemote}/${shadow}`])
      : null;

    if (currentSHA === replayedSHA) {
      console.log(`  ${shadow} is up to date.`);
      continue;
    }

    // Set to the expected remote SHA when a divergence is being force-resolved,
    // so the push below guards the rewind with --force-with-lease.
    let forceLease: string | null = null;

    if (currentSHA) {
      const isAncestor = git(
        ["merge-base", "--is-ancestor", replayedSHA, currentSHA], { safe: true },
      ).ok;
      if (isAncestor) {
        console.log(`  ${shadow} is up to date (${targetRemote} is ahead or equal).`);
        continue;
      }
      const isFF = git(
        ["merge-base", "--is-ancestor", currentSHA, replayedSHA], { safe: true },
      ).ok;
      if (!isFF) {
        const currentTree = git(["rev-parse", `${currentSHA}^{tree}`]);
        const replayedTree = git(["rev-parse", `${replayedSHA}^{tree}`]);
        if (currentTree === replayedTree) {
          console.log(`  ${shadow}: ${targetRemote} has same tree on different topology; leaving target tip in place.`);
          continue;
        }
        if (!allowShadowForce) {
          console.error(
            `✘ ${shadow}: ${targetRemote} diverged with different tree — the engine cannot ` +
            `fast-forward and never force-pushes shadow refs.\n` +
            `  Likely cause: source history on '${branch}' was rewritten (rebase / reset --hard / ` +
            `filter-branch), or the shadow ref was edited by hand.\n` +
            `  Operator must reconcile one of two ways:\n` +
            `    A) Rewrite was unintended — restore '${branch}' on '${sourceRemote}' to its pre-rewrite\n` +
            `       tip and re-run the sync (it fast-forwards again):\n` +
            `         git push --force-with-lease ${sourceRemote} <old-tip>:${branch}\n` +
            `    B) Rewrite was intended — re-run with --allow-shadow-force to let the engine advance\n` +
            `       the shadow to this run's replay with --force-with-lease. Coordinate first: the\n` +
            `       other side may have merged the old shadow history and must reconcile. Manual form:\n` +
            `         git push --force-with-lease ${targetRemote} ${replayedSHA}:refs/heads/${shadow}\n` +
            `  To avoid this, merge the shadow into the mainline BEFORE rebasing/squashing on top.`);
          failures++;
          continue;
        }
        // --allow-shadow-force: rewind the shadow to the replay, guarded by a
        // lease on the SHA we diverged against (rejects if the other side moved
        // it since this run started).
        console.log(`  ⚠ ${shadow}: ${targetRemote} diverged; advancing with --force-with-lease (--allow-shadow-force).`);
        forceLease = currentSHA;
      }
    }

    if (dryRun) {
      console.log(`  [DRY RUN] would ${forceLease ? "force-push (with lease) " : "push "}${replayedSHA} → ${targetRemote}/${shadow}`);
      continue;
    }

    console.log(`  ${forceLease ? "Force-pushing (with lease)" : "Pushing"} to ${targetRemote}/${shadow}...`);
    const pushArgs = forceLease
      ? ["push", `--force-with-lease=refs/heads/${shadow}:${forceLease}`, targetRemote, `${replayedSHA}:refs/heads/${shadow}`]
      : ["push", targetRemote, `${replayedSHA}:refs/heads/${shadow}`];
    const pushRes = git(pushArgs, { safe: true });
    if (!pushRes.ok) {
      console.error(`  ✘ ${shadow}: push failed: ${pushRes.stderr}`);
      failures++;
      continue;
    }
    console.log(`  ✓ Pushed.`);
  }

  return failures;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx shadow-sync.ts [options]
  -p, --pair <name>    Sync only this pair (default: all configured pairs)
  -r, --remote <name>  Alias for --pair
  -f, --from <side>    Which side's commits to replay: a|b or a config side
                       alias (e.g. mono|ext). Default: b
  -b, --branch <name>  Sync only this branch (bypasses branch-filters.json)
  -n, --dry-run        Replay but push nothing
      --tags           Also sync tags (off by default)
      --allow-many-commits   Override the >300-commits-per-sync safety limit
      --allow-large-commits  Override the >10MB-per-commit safety limit
      --allow-shadow-force   On shadow divergence (rewritten source history),
                             force-push the replay with --force-with-lease
                             instead of failing closed
  -h, --help           Show this help`;

if (require.main === module) {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        pair:      { type: "string",  short: "p" },
        remote:    { type: "string",  short: "r" },  // alias for --pair
        from:      { type: "string",  short: "f" },
        branch:    { type: "string",  short: "b" },
        "dry-run":   { type: "boolean", short: "n" },
        tags:        { type: "boolean" },
        "allow-many-commits":  { type: "boolean" },
        "allow-large-commits": { type: "boolean" },
        "allow-shadow-force":  { type: "boolean" },
        help:        { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (e: any) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const result = runSync({
    pair: (values.pair ?? values.remote) as string | undefined,
    from: values.from as string | undefined,
    branch: values.branch as string | undefined,
    dryRun: (values["dry-run"] as boolean | undefined) ?? false,
    tags: (values.tags as boolean | undefined) ?? false,
    allowManyCommits: (values["allow-many-commits"] as boolean | undefined) ?? false,
    allowLargeCommits: (values["allow-large-commits"] as boolean | undefined) ?? false,
    allowShadowForce: (values["allow-shadow-force"] as boolean | undefined) ?? false,
    stream: true,
  });

  process.exit(result.exitCode);
}
