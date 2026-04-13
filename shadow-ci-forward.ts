#!/usr/bin/env ts-node
/**
 * shadow-ci-forward.ts — GitHub Actions entrypoint for forwarding shadow branch
 * state to external remotes.
 *
 * Triggered when shadow/** branches are pushed to origin. Parses the branch
 * name to identify the remote + branch, takes a snapshot of the {dir}/ content
 * (stripping the dir prefix), and pushes to the external remote.
 *
 * The shadow branch and external remote stay in sync — no filtering is applied
 * here (.shadowignore is applied during shadow-export, before content reaches
 * the shadow branch).
 *
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  REMOTES, SHADOW_BRANCH_PREFIX, MAX_DIR_DEPTH,
  run, runSafe, refExists, appendTrailer,
  validateName, die,
} from "./shadow-common";

// ── Determine which shadow branch was pushed ─────────────────────────────────

const refName = process.env.GITHUB_REF_NAME;
if (!refName) {
  die("GITHUB_REF_NAME is not set. This script must run in GitHub Actions.");
}

const prefix = `${SHADOW_BRANCH_PREFIX}/`;
if (!refName.startsWith(prefix)) {
  die(`Branch '${refName}' does not start with '${prefix}'. Nothing to forward.`);
}

// Parse: shadow/{dir}/{branch} → dir="backend", branch="main" (or "feature/foo")
const rest = refName.slice(prefix.length);
const slashIdx = rest.indexOf("/");
if (slashIdx === -1) {
  die(`Cannot parse shadow branch name '${refName}'. Expected format: ${prefix}{dir}/{branch}`);
}
const dir = rest.slice(0, slashIdx);
const externalBranch = rest.slice(slashIdx + 1);
validateName(dir, "Directory");

// Find the matching remote config entry
const remoteEntry = REMOTES.find(r => r.dir === dir);
if (!remoteEntry) {
  die(`No remote configured for directory '${dir}'. Check shadow-config.json.`);
}
const remote = remoteEntry.remote;

if (!remoteEntry.url) {
  die(`No URL for remote '${remote}'. Add url to shadow-config.json.`);
}
const resolvedUrl = remoteEntry.url;

console.log(`Shadow branch : ${refName}`);
console.log(`Remote        : ${remote}`);
console.log(`Directory     : ${dir}/`);
console.log(`External branch   : ${externalBranch}`);
console.log();

// ── Add external remote and fetch ────────────────────────────────────────────

const existing = runSafe(["remote", "get-url", remote]);
if (!existing.ok) {
  run(["remote", "add", remote, resolvedUrl]);
} else if (existing.stdout !== resolvedUrl) {
  run(["remote", "set-url", remote, resolvedUrl]);
}

console.log(`Fetching from '${remote}'...`);
run(["fetch", remote]);

// ── Snapshot shadow branch content into external remote ──────────────────────

const externalRef = `${remote}/${externalBranch}`;
const externalExists = refExists(externalRef);

// Create a worktree from the external remote branch
const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-forward-")).replace(/\\/g, "/");
const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-archive-")).replace(/\\/g, "/");
const tempBranch = `shadow-forward-${Date.now()}`;
let cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(["worktree", "remove", "--force", worktreeDir]);
  runSafe(["branch", "-D", tempBranch]);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.rmSync(archiveDir, { recursive: true, force: true });
};

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// Extract {dir}/ content from shadow branch, stripping the prefix
console.log(`Extracting ${dir}/ from shadow branch...`);
const filesOutput = runSafe(["ls-tree", "-r", "--name-only", `origin/${refName}`, "--", `${dir}/`]);
if (!filesOutput.ok || !filesOutput.stdout) {
  console.log(`No files under ${dir}/ on shadow branch. Nothing to forward.`);
  process.exit(0);
}
const files = filesOutput.stdout.split("\n").filter(Boolean);

for (const filePath of files) {
  // Strip the dir prefix: "backend/src/foo.ts" → "src/foo.ts"
  const rel = filePath.slice(dir.length + 1);
  const destPath = path.join(archiveDir, rel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const gitPath = filePath.replace(/\\/g, "/");
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "show", `origin/${refName}:${gitPath}`], {
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) die(`Failed to spawn git: ${result.error.message}`);
  if (result.status !== 0) die(`Failed to extract ${gitPath} from shadow branch`);
  fs.writeFileSync(destPath, result.stdout);
}

// Create worktree from external branch (or orphan)
if (externalExists) {
  run(["worktree", "add", "-b", tempBranch, worktreeDir, externalRef]);
} else {
  run(["worktree", "add", "--orphan", "-b", tempBranch, worktreeDir]);
  spawnSync("git", ["-c", "core.autocrlf=false", "commit", "--allow-empty", "-m", "Initialize branch"], {
    cwd: worktreeDir, encoding: "utf8", stdio: "inherit",
  });
}

// Sync archive into worktree (like rsync --delete)
console.log(`Syncing to worktree...`);
syncToWorktree(archiveDir, worktreeDir);

run(["add", "-A"], worktreeDir);
const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"], worktreeDir).ok;
if (!hasStagedChanges) {
  console.log("External remote is already up to date. Nothing to forward.");
  cleanup();
  process.exit(0);
}

// Use the latest shadow branch commit message, tagged with a trailer so
// CI sync recognizes this as a forwarded commit and skips it on pull-back.
const shadowHash = run(["rev-parse", `origin/${refName}`]);
const rawMessage = run(["log", "-1", "--format=%B", `origin/${refName}`]);
const message = appendTrailer(rawMessage, `Shadow-forwarded-from: ${shadowHash}`);
const commitResult = spawnSync("git", ["-c", "core.autocrlf=false", "commit", "-m", message], {
  cwd: worktreeDir,
  encoding: "utf8",
  stdio: "inherit",
});
if (commitResult.error) die(`Failed to spawn git: ${commitResult.error.message}`);
if (commitResult.status !== 0) die("git commit failed in worktree.");

// Push to external remote
console.log(`\nPushing to ${remote}/${externalBranch}...`);
const pushResult = runSafe(["push", remote, `HEAD:${externalBranch}`], worktreeDir);
if (!pushResult.ok) {
  console.error(pushResult.stderr);
  die(`git push to ${remote}/${externalBranch} failed.`);
}

cleanup();
console.log(`\n✓ Done. Forwarded shadow/${dir}/${externalBranch} → ${remote}/${externalBranch}.`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function syncToWorktree(src: string, dest: string) {
  const destFiles = listAllFiles(dest);
  for (const rel of destFiles) {
    if (rel.startsWith(".git/") || rel === ".git") continue;
    const srcPath = path.join(src, rel);
    if (!fs.existsSync(srcPath)) {
      fs.rmSync(path.join(dest, rel), { force: true });
    }
  }
  const srcFiles = listAllFiles(src);
  for (const rel of srcFiles) {
    const srcPath = path.join(src, rel);
    const destPath = path.join(dest, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}

function listAllFiles(dir: string, prefix = "", depth = 0): string[] {
  if (depth > MAX_DIR_DEPTH) {
    console.warn(`Warning: skipping directory at depth ${depth}: ${dir}`);
    return [];
  }
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      results.push(...listAllFiles(path.join(dir, entry.name), rel, depth + 1));
    } else {
      results.push(rel);
    }
  }
  return results;
}
