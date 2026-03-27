#!/usr/bin/env ts-node
/**
 * shadow-setup.ts — Initialize shadow sync for a remote.
 *
 * Sets up the shadow branch and seed baseline so that CI sync and
 * shadow-export can operate. Run this once per remote when bootstrapping.
 *
 * What it does:
 *   1. Fetches from the external remote
 *   2. Records a seed commit so CI sync skips existing history
 *
 * Usage:
 *   npx tsx shadow-setup.ts -r backend
 *   npx tsx shadow-setup.ts -r frontend -b feature/auth
 */
import { parseArgs } from "util";
import {
  REMOTES, SEED_TRAILER,
  run, refExists, listExternalBranches,
  getCurrentBranch, appendTrailer,
  validateName, die,
  preflightChecks, handlePreflightResults,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote:  { type: "string",  short: "r" },
    dir:     { type: "string",  short: "d" },
    branch:  { type: "string",  short: "b" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-setup.ts [-r remote] [-d dir] [-b branch]");
  console.log("  -r  Remote name             (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory       (default: inferred from remote config)");
  console.log("  -b  Branch to set up         (default: your current branch)");
  process.exit(0);
}

// ── Resolve config ───────────────────────────────────────────────────────────

const localBranch = getCurrentBranch();

const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  die(`Remote '${values.remote}' not found in REMOTES. Add it to shadow-config.json.`);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const externalBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");

const externalRef      = `${remote}/${externalBranch}`;

console.log(`Remote        : ${remote}`);
console.log(`Directory     : ${dir}/`);
console.log(`External branch   : ${externalBranch}`);
console.log();

// ── Fetch external remote ────────────────────────────────────────────────────

console.log(`Fetching from '${remote}'...`);
run(["fetch", remote]);

if (!refExists(externalRef)) {
  console.error(`✘ '${externalRef}' does not exist. Available branches on '${remote}':`);
  listExternalBranches(remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

// Pre-flight checks
const warnings = preflightChecks(externalRef);
if (!handlePreflightResults(warnings)) {
  process.exit(1);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

const tipHash = run(["rev-parse", externalRef]);
const msg = appendTrailer(
  `Seed shadow-sync for ${dir}/ from ${externalRef}`,
  `${SEED_TRAILER}: ${dir} ${tipHash}`,
);
run(["commit", "--allow-empty", "-m", msg]);

console.log(`✓ Seeded: CI sync for '${dir}/' will start after ${tipHash.slice(0, 10)}.`);
console.log();
console.log("Next steps:");
console.log(`  1. Push this commit:  git push`);
console.log(`  2. Trigger CI sync or wait for the next cron run`);
console.log(`  3. Export changes:    npm run export -- -r ${remote} -m "your message"`);
