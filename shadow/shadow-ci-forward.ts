#!/usr/bin/env ts-node
/**
 * shadow-ci-forward.ts — Forward local commits to external remotes.
 *
 * For each configured remote, replays local commits (that touch dir/) to a
 * shadow branch on the external repo, stripping the dir/ prefix. The external
 * team can `git merge` the shadow branch to pull in changes.
 *
 * This is the mirror of ci-sync: ci-sync adds a prefix, ci-forward strips it.
 *
 * Can run in CI (GitHub Actions) or locally.
 *
 * Usage:
 *   npx tsx shadow-ci-forward.ts              # forward all remotes
 *   npx tsx shadow-ci-forward.ts -r backend   # forward one remote
 */
import { parseArgs } from "util";
import * as path from "path";
import {
  REMOTES, SHADOW_BRANCH_PREFIX,
  git, replayCommitsOutgoing,
  getCurrentBranch, validateName, die,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote: { type: "string", short: "r" },
    branch: { type: "string", short: "b" },
  },
  strict: true,
});

const remotesToForward = values.remote
  ? REMOTES.filter(r => r.remote === values.remote)
  : REMOTES;

if (values.remote && remotesToForward.length === 0) {
  die(`Remote '${values.remote}' not found in config.`);
}

const localBranch = values.branch ?? getCurrentBranch();
const shadowIgnoreFile = path.join(__dirname, ".shadowignore");
let failed = 0;

// Refuse if working tree has uncommitted changes to any dir we're forwarding
for (const { dir } of remotesToForward) {
  const dirty = !git(["diff", "--cached", "--quiet", "--", `${dir}/`], { safe: true, plain: true }).ok
    || !git(["diff", "--quiet", "HEAD", "--", `${dir}/`], { safe: true, plain: true }).ok;
  if (dirty) {
    console.error(`✘ '${dir}/' has uncommitted changes. Commit or stash them first.`);
    process.exit(1);
  }
}

for (const { remote, dir, url } of remotesToForward) {
  validateName(remote, "Remote name");
  validateName(dir, "Directory");

  // Add or update the git remote
  const existing = git(["remote", "get-url", remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", remote, url]);
  } else if (existing.stdout !== url) {
    git(["remote", "set-url", remote, url]);
  }

  console.log(`\n══ Forwarding to '${remote}' ══`);
  git(["fetch", remote]);

  const externalBranch = localBranch;
  const extShadowBranch = `${SHADOW_BRANCH_PREFIX}/${externalBranch}`;

  try {
    const result = replayCommitsOutgoing({
      remote, dir, localBranch, externalBranch, shadowIgnoreFile,
    });

    if (result.upToDate) {
      console.log("  Already up to date.");
      continue;
    }

    if (result.tipSHA) {
      console.log(`  Pushing to ${remote}/${extShadowBranch}...`);
      const pushResult = git(
        ["push", remote, `${result.tipSHA}:refs/heads/${extShadowBranch}`],
        { safe: true },
      );
      if (!pushResult.ok) {
        console.error(pushResult.stderr);
        throw new Error(`Push to ${remote}/${extShadowBranch} failed.`);
      }
      console.log(`  ✓ Pushed ${result.mirrored} commit(s).`);
    }
  } catch (err: any) {
    console.error(`  ✘ Failed to forward to ${remote}: ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} forward(s) failed.`);
  process.exit(1);
}

console.log("\n✓ All forwards completed successfully.");
