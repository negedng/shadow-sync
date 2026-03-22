#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import {
  REMOTES, PUSH_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, appendTrailer,
  parseShadowIgnore, acquireLock, die,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    message: { type: "string",  short: "m" },
    remote:  { type: "string",  short: "r" },
    dir:     { type: "string",  short: "d" },
    branch:  { type: "string",  short: "b" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help || !values.message) {
  console.log('Usage: shadow-push.ts -m "Your commit message" [-r remote] [-d dir] [-b team-branch]');
  console.log("  -m  Commit message (required)");
  console.log("  -r  Remote name to push to       (default: team)");
  console.log("  -d  Local subdirectory to push from  (default: same as remote name)");
  console.log("  -b  Team branch to push to       (default: your current branch)");
  process.exit(values.help ? 0 : 1);
}

const commitMsg = values.message;

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
const localHead  = run("git rev-parse HEAD");

// Refuse to push if the local dir has uncommitted changes
const dirtyStaged   = !runSafe(`git diff --cached --quiet -- ${dir}/`).ok;
const dirtyUnstaged = !runSafe(`git diff --quiet HEAD -- ${dir}/`).ok;
if (dirtyStaged || dirtyUnstaged) {
  console.error(`✘ '${dir}/' has uncommitted changes:\n`);
  execSync(`git status --short -- ${dir}/`, { stdio: "inherit" });
  console.error(`\nCommit or stash them before running shadow-push.`);
  process.exit(1);
}

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Team branch   : ${teamBranch}`);
console.log();

// ── .shadowignore ─────────────────────────────────────────────────────────────

const ignore = parseShadowIgnore(SCRIPT_DIR);

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from remote '${remote}'...`);
run(`git fetch ${remote}`);

let resolvedTeamRef = teamRef;

if (!refExists(teamRef)) {
  console.error(`\n⚠ '${teamRef}' does not exist on the remote.`);
  console.error("Available branches:");
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(res =>
    rl.question(`\nCreate '${teamBranch}' on '${remote}'? [y/N] `, res)
  );
  rl.close();

  if (answer.toLowerCase() !== "y") { console.log("Aborted."); process.exit(0); }

  const base = ["main", "master"].find(c => refExists(`${remote}/${c}`));
  if (!base) die(`Could not find a base branch (main/master) on '${remote}'.`);

  resolvedTeamRef = `${remote}/${base}`;
  console.log(`Branching from ${resolvedTeamRef}...`);
}

// ── Worktree ──────────────────────────────────────────────────────────────────

const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-push-"));
const archiveDir  = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-archive-"));
const tempBranch  = `shadow-push-${Date.now()}`;
let   cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(`git worktree remove --force ${worktreeDir}`);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.rmSync(archiveDir,  { recursive: true, force: true });
};

process.on("exit",    cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

console.log(`Extracting committed '${dir}/' from HEAD...`);
execSync(
  `git archive HEAD -- ${dir} | tar -x --strip-components=1 -C ${archiveDir}`,
  { shell: true }
);

run(`git worktree add -b ${tempBranch} ${worktreeDir} ${resolvedTeamRef}`);

console.log(`Syncing into temporary worktree...`);

const rsyncCmd = [
  "rsync", "-a", "--delete",
  ...ignore.rsyncExcludes,
  ...ignore.rsyncProtects,
  "--exclude=.git",
  `${archiveDir}/`,
  `${worktreeDir}/`,
].join(" ");

execSync(rsyncCmd, { stdio: "inherit" });

// ── Commit & push ─────────────────────────────────────────────────────────────

run("git add -A", worktreeDir);

const hasStagedChanges = !runSafe("git diff --cached --quiet", worktreeDir).ok;
if (!hasStagedChanges) {
  console.log("No changes to push — their repo is already up to date.");
  cleanup();
  process.exit(0);
}

console.log("\nChanges to be pushed:");
execSync("git diff --cached --stat", { cwd: worktreeDir, stdio: "inherit" });
console.log();

const fullMsg = appendTrailer(commitMsg, `${PUSH_TRAILER}: ${localHead}`);
execSync(`git commit -m ${JSON.stringify(fullMsg)}`, { cwd: worktreeDir, stdio: "inherit" });

console.log(`Pushing to ${remote}/${teamBranch}...`);
run(`git push ${remote} HEAD:${teamBranch}`, worktreeDir);

cleanup();

console.log();
console.log(`✓ Done. Pushed '${dir}/' → ${remote}/${teamBranch} as: "${commitMsg}"`);
