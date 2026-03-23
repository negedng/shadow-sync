#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  REMOTES, SYNC_TRAILER, PUSH_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, getCommitMeta, diffForCommit,
  applyPatch, extractPatchFiles, commitWithMeta, appendTrailer,
  buildAlreadySyncedSetFor, collectTeamCommits,
  acquireLock, die, setSyncSince,
  saveConflictState, loadConflictState, clearConflictState,
  preflightChecks, handlePreflightResults,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    remote:  { type: "string",  short: "r" },
    dir:     { type: "string",  short: "d" },
    branch:  { type: "string",  short: "b" },
    since:   { type: "string",  short: "s" },
    "dry-run": { type: "boolean", short: "n" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b team-branch] [-s date] [-n]");
  console.log("  -r  Remote name to pull from         (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory to sync into  (default: same as remote name)");
  console.log("  -b  Team branch to mirror            (default: your current branch)");
  console.log("  -s  Only sync commits after date     (default: SYNC_SINCE in config)");
  console.log("  -n  Dry run — show what would be synced without applying");
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

// Refuse to pull if the local dir has uncommitted changes — applying patches
// on top of a dirty working tree can silently overwrite local edits.
// Exception: when resuming after a conflict, the user's staged resolution is expected.
const resumingConflict = loadConflictState(SCRIPT_DIR);
if (!resumingConflict || resumingConflict.remote !== remote || resumingConflict.dir !== dir) {
  const dirtyStaged   = !runSafe(["diff", "--cached", "--quiet", "--", `${dir}/`]).ok;
  const dirtyUnstaged = !runSafe(["diff", "--quiet", "HEAD", "--", `${dir}/`]).ok;
  const hasUntracked  = runSafe(["ls-files", "--others", "--exclude-standard", "--", `${dir}/`]).stdout !== "";
  if (dirtyStaged || dirtyUnstaged || hasUntracked) {
    console.error(`✘ '${dir}/' has uncommitted changes:\n`);
    spawnSync("git", ["-c", "core.autocrlf=false", "status", "--short", "--", `${dir}/`], { stdio: "inherit" });
    console.error(`\nCommit or stash them before running shadow-pull.`);
    process.exit(1);
  }
}

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

// ── Determine which commits to apply ─────────────────────────────────────────

console.log("Scanning local history for already-mirrored commits...");
const alreadySynced = buildAlreadySyncedSetFor(dir);
console.log(`Found ${alreadySynced.size} previously mirrored commit(s).`);

const allTeamCommits = collectTeamCommits(teamRef);

const newCommits: string[] = [];
let   skippedOurs = 0;

for (const hash of allTeamCommits) {
  if (alreadySynced.has(hash)) continue;

  const body = run(["log", "-1", "--format=%B", hash]);
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

if (dryRun) {
  console.log("\n[DRY RUN] The following commits would be mirrored:\n");
  for (const hash of newCommits) {
    const meta = getCommitMeta(hash);
    console.log(`  ${meta.short}`);
  }
  console.log("\nNo changes were made.");
  process.exit(0);
}

console.log();

// ── Resume after conflict resolution ──────────────────────────────────────────

const pendingConflict = loadConflictState(SCRIPT_DIR);
if (pendingConflict && pendingConflict.remote === remote && pendingConflict.dir === dir) {
  const unmerged = runSafe(["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.ok && unmerged.stdout) {
    console.error("✘ There are still unresolved conflicts. Resolve them and stage before re-running.");
    process.exit(1);
  }

  const hash = pendingConflict.hash;
  const meta = getCommitMeta(hash);
  console.log(`  Resuming ${meta.short} (conflict resolved)...`);

  run(["add", `${dir}/`]);

  const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"]).ok;
  const syncedMessage    = appendTrailer(meta.message, `${SYNC_TRAILER}: ${hash}`);

  if (!hasStagedChanges) {
    console.log("    (no changes after resolution — recording as synced)");
    commitWithMeta(meta, syncedMessage, /* allowEmpty */ true);
    console.log("  ✓ Recorded (empty).");
  } else {
    commitWithMeta(meta, syncedMessage);
    console.log("  ✓ Mirrored (conflict resolved).");
  }

  clearConflictState(SCRIPT_DIR);
  alreadySynced.add(hash);
}

// ── Apply commits ─────────────────────────────────────────────────────────────

for (const hash of newCommits) {
  if (alreadySynced.has(hash)) continue;

  const meta = getCommitMeta(hash);

  const label = meta.parentCount > 1
    ? `merge commit ${meta.short} (diffing against first parent)`
    : meta.parentCount === 0
      ? `root commit ${meta.short}`
      : meta.short;

  console.log(`  Applying ${label}...`);

  const patch = diffForCommit(meta);

  const result = applyPatch(patch, dir);

  if (result === "conflict") {
    saveConflictState(SCRIPT_DIR, { hash, remote, dir });
    console.error(`\n  ✘ Merge conflict while applying ${meta.short}`);
    console.error(`    Resolve the conflicts, stage your changes, then re-run.`);
    process.exit(1);
  }

  if (result === "failed") {
    console.error(`\n  ✘ Could not apply patch for ${meta.short}`);
    console.error(`    The 3-way merge could not be attempted (missing blob objects?).`);
    process.exit(1);
  }

  // Stage only the files touched by the patch — avoids accidentally staging
  // untracked files that happen to exist in the subdirectory.
  const patchFiles = extractPatchFiles(patch, dir);
  if (patchFiles.length > 0) {
    run(["add", "--", ...patchFiles]);
  }

  const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"]).ok;
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
