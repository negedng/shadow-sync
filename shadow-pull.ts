#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import {
  REMOTES, SEED_TRAILER,
  run, refExists, listTeamBranches,
  getCurrentBranch, appendTrailer,
  acquireLock, validateName, die, setSyncSince,
  preflightChecks, handlePreflightResults,
  replayCommits,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    remote:  { type: "string",  short: "r" },
    dir:     { type: "string",  short: "d" },
    branch:  { type: "string",  short: "b" },
    since:   { type: "string",  short: "s" },
    seed:    { type: "boolean" },
    "dry-run": { type: "boolean", short: "n" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b team-branch] [-s date] [-n] [--seed]");
  process.exit(0);
}

const dryRun = values["dry-run"] ?? false;
if (values.since !== undefined) setSyncSince(values.since || undefined);

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR  = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
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
const teamRef    = `${remote}/${teamBranch}`;

acquireLock(SCRIPT_DIR, "shadow-pull");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Team branch   : ${teamBranch}`);
console.log();

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching from remote '${remote}'...`);
run(["fetch", remote]);

if (!refExists(teamRef)) {
  console.error(`✘ '${teamRef}' does not exist. Available branches on '${remote}':`);
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

// ── Pre-flight checks ────────────────────────────────────────────────────────

const warnings = preflightChecks(remote, teamRef);
if (!handlePreflightResults(warnings)) {
  process.exit(1);
}

// ── Seed mode ─────────────────────────────────────────────────────────────────

if (values.seed) {
  const tipHash = run(["rev-parse", teamRef]);
  const msg = appendTrailer(
    `Seed shadow-sync for ${dir}/ from ${teamRef}`,
    `${SEED_TRAILER}: ${dir} ${tipHash}`,
  );
  run(["commit", "--allow-empty", "-m", msg]);
  console.log(`✓ Seeded: future pulls for '${dir}/' will start after ${tipHash.slice(0, 10)}.`);
  process.exit(0);
}

// ── Replay commits ───────────────────────────────────────────────────────────

try {
  const result = replayCommits({ remote, dir, teamBranch, dryRun });
  if (result.upToDate || dryRun) {
    process.exit(0);
  }
} catch (err: any) {
  die(err.message);
}
