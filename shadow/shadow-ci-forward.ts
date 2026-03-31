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
import {
  REMOTES, SHADOW_BRANCH_PREFIX,
  git, refExists, appendTrailer,
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

const existing = git(["remote", "get-url", remote], { safe: true });
if (!existing.ok) {
  git(["remote", "add", remote, resolvedUrl]);
} else if (existing.stdout !== resolvedUrl) {
  git(["remote", "set-url", remote, resolvedUrl]);
}

console.log(`Fetching from '${remote}'...`);
git(["fetch", remote]);

// ── Build tree and push to external remote ───────────────────────────────────

const externalRef = `${remote}/${externalBranch}`;
const externalExists = refExists(externalRef);

const tmpIndex = path.join(os.tmpdir(), `shadow-fwd-idx-${Date.now()}`);
process.env.GIT_INDEX_FILE = tmpIndex;

try {
  // Read dir/ from shadow branch at root level (strips the prefix)
  console.log(`Building tree from ${dir}/ on shadow branch...`);
  git(["read-tree", "--empty"]);
  const treeCheck = git(["rev-parse", `origin/${refName}:${dir}`], { safe: true });
  if (!treeCheck.ok) {
    console.log(`No files under ${dir}/ on shadow branch. Nothing to forward.`);
    process.exit(0);
  }
  git(["read-tree", `origin/${refName}:${dir}`]);
  const tree = git(["write-tree"]);

  // Check if anything changed
  if (externalExists) {
    const externalTree = git(["rev-parse", `${externalRef}^{tree}`]);
    if (tree === externalTree) {
      console.log("External remote is already up to date. Nothing to forward.");
      process.exit(0);
    }
  }

  // Build commit message from the shadow branch merge commit.
  // Strip existing Shadow-* trailers to prevent accumulation across round-trips.
  // Add our own trailer so CI sync recognizes it and skips it on pull-back.
  const shadowHash = git(["rev-parse", `origin/${refName}`]);
  const rawMessage = git(["log", "-1", "--format=%B", `origin/${refName}`]);
  const cleanMessage = rawMessage.split("\n").filter(l => !l.match(/^Shadow-/)).join("\n").trimEnd();
  const message = appendTrailer(cleanMessage, `Shadow-forwarded-from: ${shadowHash}`);

  // Create commit (with external branch tip as parent if it exists)
  const parentArgs = externalExists ? ["-p", git(["rev-parse", externalRef])] : [];
  const newCommit = git(["commit-tree", tree, ...parentArgs, "-m", message]);

  // Push to external remote
  console.log(`\nPushing to ${remote}/${externalBranch}...`);
  const pushResult = git(["push", remote, `${newCommit}:refs/heads/${externalBranch}`], { safe: true });
  if (!pushResult.ok) {
    console.error(pushResult.stderr);
    die(`git push to ${remote}/${externalBranch} failed.`);
  }

  console.log(`\n✓ Done. Forwarded shadow/${dir}/${externalBranch} → ${remote}/${externalBranch}.`);
} finally {
  delete process.env.GIT_INDEX_FILE;
  fs.rmSync(tmpIndex, { force: true });
}
