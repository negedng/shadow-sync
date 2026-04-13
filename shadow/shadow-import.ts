#!/usr/bin/env ts-node
/**
 * shadow-import.ts — Import external changes into your local branch.
 *
 * Convenience wrapper around: git fetch origin && git merge origin/shadow/{dir}/{branch}
 *
 * Usage:
 *   npx tsx shadow-import.ts
 *   npx tsx shadow-import.ts -r frontend
 */
import { parseArgs } from "util";
import {
  REMOTES,
  git, refExists,
  getCurrentBranch, shadowBranchName,
  validateName, die,
} from "./shadow-common";

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
  console.log("Usage: shadow-import.ts [-r remote] [-d dir] [-b branch]");
  process.exit(0);
}

const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];
if (values.remote && !remoteEntry) die(`Remote '${values.remote}' not found.`);

const dir    = values.dir    ?? remoteEntry!.dir;
const branch = values.branch ?? getCurrentBranch();
validateName(dir, "Directory");

const pushOrigin = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowRef  = `${pushOrigin}/${shadowBranchName(dir, branch)}`;

git(["fetch", pushOrigin]);

if (!refExists(shadowRef)) die(`${shadowRef} does not exist. Run ci-sync first.`);

if (git(["merge-base", "--is-ancestor", shadowRef, "HEAD"], { safe: true }).ok) {
  console.log("Already up to date.");
  process.exit(0);
}

const r = git(["merge", "--no-ff", shadowRef], { safe: true, plain: true });
if (!r.ok) {
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  die("Merge failed. Resolve conflicts, then: git add <files> && git commit");
}

console.log(`✓ Merged ${shadowRef}.`);
