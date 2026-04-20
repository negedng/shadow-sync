#!/usr/bin/env ts-node
/**
 * shadow-setup.ts — Record a seed baseline for a pair.
 *
 * The seed commit anchors shadow branches to target-side history so that
 * `git merge origin/shadow/<pair>/<branch>` finds a proper merge base.
 *
 * Implementation: creates the seed via plumbing (`git commit-tree`) as a
 * child of the target branch's current tip, then pushes directly to the
 * target remote. This works identically in workspace mode (target is
 * `origin`) and orchestrator mode (target is an external remote), and
 * never touches the workspace's HEAD.
 *
 * Default (no `-b`): seeds every branch present on both remotes, skipping
 * ones already seeded. Idempotent — safe to re-run as new branches appear.
 * Pass `-b <branch>` to seed just that branch.
 *
 * Usage:
 *   npx tsx shadow-setup.ts -r backend
 *   npx tsx shadow-setup.ts -r backend -b client-x
 *   npx tsx shadow-setup.ts -r backend --from a
 */
import { parseArgs } from "util";
import {
  PAIRS, SEED_TRAILER, ShadowSyncError,
  git, refExists, listBranches, ensureRemote,
  appendTrailer,
  validateName, die,
  preflightChecks, handlePreflightResults,
} from "./shadow-common";

try {

const { values } = parseArgs({
  options: {
    remote:  { type: "string",  short: "r" },
    from:    { type: "string",  short: "f" },
    branch:  { type: "string",  short: "b" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-setup.ts [-r pair] [--from a|b] [-b branch]");
  console.log("  -r  Pair name                (default: first pair)");
  console.log("  --from  Which side's tip to record as the seed baseline (default: b)");
  console.log("  -b  Branch to seed           (default: every branch on both remotes)");
  process.exit(0);
}

const pair = values.remote
  ? PAIRS.find(p => p.name === values.remote)
  : PAIRS[0];

if (values.remote && !pair) {
  die(`Pair '${values.remote}' not found in config.`);
}
if (!pair) {
  die("No pairs configured in shadow-config.json.");
}

const fromSide = (values.from ?? "b") as "a" | "b";
if (fromSide !== "a" && fromSide !== "b") {
  die(`--from must be "a" or "b", got "${values.from}".`);
}

const source = fromSide === "a" ? pair.a : pair.b;
const target = fromSide === "a" ? pair.b : pair.a;
validateName(pair.name, "Pair name");
validateName(source.remote, "Source remote");
validateName(target.remote, "Target remote");

console.log(`Pair          : ${pair.name}`);
console.log(`Seeding from  : ${fromSide} (${source.remote})`);
console.log(`Seed lands on : ${target.remote}`);

ensureRemote(pair.a);
ensureRemote(pair.b);

console.log(`Fetching '${source.remote}' and '${target.remote}'...`);
git(["fetch", source.remote]);
git(["fetch", target.remote]);

let branches: string[];
if (values.branch) {
  validateName(values.branch, "Branch");
  branches = [values.branch];
} else {
  const sourceBranches = new Set(listBranches(source.remote));
  branches = listBranches(target.remote).filter(b => sourceBranches.has(b));
  if (branches.length === 0) {
    die(`No branches exist on both '${source.remote}' and '${target.remote}'.`);
  }
  console.log(`Branches      : ${branches.join(", ")}`);
}
console.log();

const isAlreadySeeded = (targetRef: string): boolean => {
  const result = git(
    ["log", targetRef, `--grep=^${SEED_TRAILER}: ${pair!.name} `, "-1", "--format=%H"],
    { safe: true },
  );
  return result.ok && result.stdout.length > 0;
};

let seededCount = 0;
let skippedCount = 0;
for (const branch of branches) {
  const sourceRef = `${source.remote}/${branch}`;
  const targetRef = `${target.remote}/${branch}`;

  if (!refExists(sourceRef)) {
    console.log(`[${branch}] skipped — not on '${source.remote}'.`);
    skippedCount++;
    continue;
  }
  if (!refExists(targetRef)) {
    console.log(`[${branch}] skipped — not on '${target.remote}'.`);
    skippedCount++;
    continue;
  }

  if (isAlreadySeeded(targetRef)) {
    console.log(`[${branch}] already seeded, skipping.`);
    skippedCount++;
    continue;
  }

  const warnings = preflightChecks(sourceRef);
  if (!handlePreflightResults(warnings)) {
    process.exit(1);
  }

  const sourceTip = git(["rev-parse", sourceRef]);
  const targetTip = git(["rev-parse", targetRef]);
  const targetTree = git(["rev-parse", `${targetTip}^{tree}`]);

  const msg = appendTrailer(
    `Seed shadow-sync for ${pair.name} from ${sourceRef}`,
    `${SEED_TRAILER}: ${pair.name} ${sourceTip}`,
  );

  const seedSHA = git(["commit-tree", targetTree, "-p", targetTip, "-m", msg]);

  console.log(`[${branch}] pushing seed to ${target.remote}/${branch}...`);
  git(["push", target.remote, `${seedSHA}:refs/heads/${branch}`]);
  console.log(`[${branch}] ✓ seeded after ${sourceTip.slice(0, 10)}.`);
  seededCount++;
}

console.log();
console.log(`✓ Done: ${seededCount} seeded, ${skippedCount} skipped.`);
if (seededCount > 0) {
  console.log();
  console.log("Next steps:");
  console.log(`  1. If working on ${target.remote}, run 'git pull' to fetch the seed commit(s).`);
  console.log(`  2. Run sync:  npm run sync -- -r ${pair.name} --from ${fromSide}`);
}

} catch (e) {
  if (e instanceof ShadowSyncError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
