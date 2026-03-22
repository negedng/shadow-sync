#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import {
  REMOTES, SYNC_TRAILER, PUSH_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, getCommitMeta, diffForCommit,
  applyPatch, commitWithMeta, appendTrailer,
  buildAlreadySyncedSetFor, collectTeamCommits,
  acquireLock, die,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    remote: { type: "string",  short: "r" },
    dir:    { type: "string",  short: "d" },
    branch: { type: "string",  short: "b" },
    help:   { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b team-branch]");
  console.log("  -r  Remote name to pull from     (default: team)");
  console.log("  -d  Local subdirectory to sync into  (default: same as remote name)");
  console.log("  -b  Team branch to mirror        (default: your current branch)");
  process.exit(0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR  = path.dirname(new URL(import.meta.url ?? `file://${__filename}`).pathname);
const localBranch = getCurrentBranch();

// Resolve remote + dir: explicit flags win, then look up in REMOTES, then fall
// back to the first entry. -r alone infers dir from REMOTES; -d alone is an error.
const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  console.error(`✘ Remote '${values.remote}' not found in REMOTES. Add it to shadow-common.ts.`);
  process.exit(1);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const teamBranch = values.branch ?? localBranch;
const teamRef    = `${remote}/${teamBranch}`;

acquireLock(SCRIPT_DIR, "shadow-pull");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Team branch   : ${teamBranch}`);
console.log();

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching from remote '${remote}'...`);
run(`git fetch ${remote}`);

if (!refExists(teamRef)) {
  console.error(`✘ '${teamRef}' does not exist. Available branches on '${remote}':`);
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

// ── Determine which commits to apply ─────────────────────────────────────────

console.log("Scanning local history for already-mirrored commits...");
const alreadySynced = buildAlreadySyncedSetFor(dir);
console.log(`Found ${alreadySynced.size} previously mirrored commit(s).`);

const allTeamCommits = collectTeamCommits(teamRef);

const newCommits: string[] = [];
let   skippedOurs = 0;

for (const hash of allTeamCommits) {
  if (alreadySynced.has(hash)) continue;

  const body = run(`git log -1 --format="%B" ${hash}`);
  if (body.includes(`${PUSH_TRAILER}:`)) {
    skippedOurs++;
    continue;
  }

  newCommits.push(hash);
}

if (skippedOurs > 0) {
  console.log(`Skipped ${skippedOurs} commit(s) that originated from you (shadow-push).`);
}

if (newCommits.length === 0) {
  console.log("Already up to date. Nothing to mirror.");
  process.exit(0);
}

console.log(`Found ${newCommits.length} new commit(s) to mirror.`);
console.log();

// ── Apply commits ─────────────────────────────────────────────────────────────

for (const hash of newCommits) {
  const meta = getCommitMeta(hash);

  const label = meta.parentCount > 1
    ? `merge commit ${meta.short} (diffing against first parent)`
    : meta.parentCount === 0
      ? `root commit ${meta.short}`
      : meta.short;

  console.log(`  Applying ${label}...`);

  const patch = diffForCommit(meta);

  if (!applyPatch(patch, dir)) {
    console.error(`\n  ✘ Patch did not apply cleanly for ${meta.short}`);
    console.error(`    Fix the .rej files, stage your changes, then re-run.`);
    process.exit(1);
  }

  run(`git add ${dir}/`);

  const hasStagedChanges = !runSafe("git diff --cached --quiet").ok;
  const syncedMessage    = appendTrailer(meta.message, `${SYNC_TRAILER}: ${hash}`);

  if (!hasStagedChanges) {
    console.log("    (no changes after apply — recording as synced)");
    commitWithMeta(meta, syncedMessage, /* allowEmpty */ true);
    console.log("  ✓ Recorded (empty).");
    continue;
  }

  commitWithMeta(meta, syncedMessage);
  console.log("  ✓ Mirrored.");
}

console.log();
console.log(
  `Done. ${newCommits.length} commit(s) from '${remote}/${teamBranch}' mirrored into '${dir}/' on '${localBranch}'.`
);
