#!/usr/bin/env ts-node
/**
 * shadow-setup.ts — Record a seed baseline for a pair.
 *
 * Tells shadow-sync where to start — commits before the seed are skipped.
 * Run once per pair when bootstrapping.
 *
 * Usage:
 *   npx tsx shadow-setup.ts -r backend
 *   npx tsx shadow-setup.ts -r backend --from a
 */
import { parseArgs } from "util";
import {
  PAIRS, SEED_TRAILER,
  git, refExists, listBranches, ensureRemote,
  getCurrentBranch, appendTrailer,
  validateName, die,
  preflightChecks, handlePreflightResults,
} from "./shadow-common";

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
  console.log("  --from  Which side to seed from (default: b)");
  console.log("  -b  Branch to seed           (default: current branch)");
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
const targetBranch = values.branch ?? getCurrentBranch();
validateName(pair.name, "Pair name");
validateName(source.remote, "Remote name");

const targetRef = `${source.remote}/${targetBranch}`;

console.log(`Pair          : ${pair.name}`);
console.log(`Seeding from  : ${fromSide} (${source.remote})`);
console.log(`Branch        : ${targetBranch}`);
console.log();

ensureRemote(pair.a);
ensureRemote(pair.b);

console.log(`Fetching from '${source.remote}'...`);
git(["fetch", source.remote]);

if (!refExists(targetRef)) {
  console.error(`✘ '${targetRef}' does not exist. Available branches on '${source.remote}':`);
  listBranches(source.remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

const warnings = preflightChecks(targetRef);
if (!handlePreflightResults(warnings)) {
  process.exit(1);
}

const tipHash = git(["rev-parse", targetRef]);
const msg = appendTrailer(
  `Seed shadow-sync for ${pair.name} from ${targetRef}`,
  `${SEED_TRAILER}: ${pair.name} ${tipHash}`,
);
git(["commit", "--allow-empty", "-m", msg]);

console.log(`✓ Seeded: sync for '${pair.name}' will start after ${tipHash.slice(0, 10)}.`);
console.log();
console.log("Next steps:");
console.log(`  1. Run sync:  npm --prefix shadow run sync -- -r ${pair.name} --from ${fromSide}`);
