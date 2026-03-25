#!/usr/bin/env ts-node
/**
 * shadow-setup.ts — Initialize shadow sync for a remote.
 *
 * Sets up the shadow branch and seed baseline so that CI sync and
 * shadow-export can operate. Run this once per remote when bootstrapping.
 *
 * What it does:
 *   1. Fetches from the external remote
 *   2. Creates the shadow branch (shadow/{dir}/{branch}) on origin as an orphan
 *   3. Records a seed commit so CI sync skips existing history
 *
 * Usage:
 *   npx tsx shadow-setup.ts -r backend
 *   npx tsx shadow-setup.ts -r frontend -b feature/auth
 */
import { parseArgs } from "util";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  REMOTES, SEED_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, appendTrailer, shadowBranchName,
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
const teamBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");

const pushOrigin   = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowBranch = shadowBranchName(dir, teamBranch);
const teamRef      = `${remote}/${teamBranch}`;
const shadowRef    = `${pushOrigin}/${shadowBranch}`;

console.log(`Remote        : ${remote}`);
console.log(`Directory     : ${dir}/`);
console.log(`Team branch   : ${teamBranch}`);
console.log(`Shadow branch : ${shadowBranch}`);
console.log();

// ── Fetch external remote ────────────────────────────────────────────────────

console.log(`Fetching from '${remote}'...`);
run(["fetch", remote]);

if (!refExists(teamRef)) {
  console.error(`✘ '${teamRef}' does not exist. Available branches on '${remote}':`);
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

// Pre-flight checks
const warnings = preflightChecks(remote, teamRef);
if (!handlePreflightResults(warnings)) {
  process.exit(1);
}

// ── Fetch origin ─────────────────────────────────────────────────────────────

console.log(`Fetching from '${pushOrigin}'...`);
runSafe(["fetch", pushOrigin]);

// ── Create shadow branch if needed ───────────────────────────────────────────

if (refExists(shadowRef)) {
  console.log(`Shadow branch '${shadowRef}' already exists. Skipping creation.`);
} else {
  console.log(`Creating shadow branch '${shadowBranch}'...`);

  // Create an orphan branch with an empty initial commit
  const tempBranch = `shadow-setup-${Date.now()}`;
  run(["checkout", "--orphan", tempBranch]);
  run(["reset", "--hard"]);
  spawnSync("git", ["commit", "--allow-empty", "-m", "Initialize shadow branch"], {
    encoding: "utf8", stdio: "inherit",
  });

  // Push to origin as the shadow branch
  run(["push", pushOrigin, `HEAD:${shadowBranch}`]);

  // Clean up: go back to original branch, delete temp
  run(["checkout", localBranch]);
  runSafe(["branch", "-D", tempBranch]);

  console.log(`✓ Created ${pushOrigin}/${shadowBranch}.`);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

const tipHash = run(["rev-parse", teamRef]);
const msg = appendTrailer(
  `Seed shadow-sync for ${dir}/ from ${teamRef}`,
  `${SEED_TRAILER}: ${dir} ${tipHash}`,
);
run(["commit", "--allow-empty", "-m", msg]);

console.log(`✓ Seeded: CI sync for '${dir}/' will start after ${tipHash.slice(0, 10)}.`);
console.log();
console.log("Next steps:");
console.log(`  1. Push this commit:  git push`);
console.log(`  2. Trigger CI sync or wait for the next cron run`);
console.log(`  3. Export changes:    npm run export -- -r ${remote} -m "your message"`);
