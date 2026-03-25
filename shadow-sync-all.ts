#!/usr/bin/env ts-node
import { parseArgs } from "util";
import { spawnSync } from "child_process";
import * as path from "path";
import {
  REMOTES, run, runSafe, listTeamBranches,
  getCurrentBranch, die, shadowBranchName,
} from "./shadow-common";

const { values } = parseArgs({
  options: {
    remote:    { type: "string",  short: "r" },
    "dry-run": { type: "boolean", short: "n" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-sync-all.ts [-r remote] [-n]");
  process.exit(0);
}

const SCRIPT_DIR = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

const originalBranch = getCurrentBranch();
const dryRun = values["dry-run"] ?? false;

const remotes = values.remote
  ? REMOTES.filter(r => r.remote === values.remote)
  : REMOTES;

if (remotes.length === 0) die(`Remote '${values.remote}' not found in config.`);

let failed = 0;

for (const { remote, dir } of remotes) {
  run(["fetch", remote]);

  for (const branch of listTeamBranches(remote)) {
    const shadowBranch = shadowBranchName(dir, branch);
    console.log(`\n── ${remote}/${branch} → ${shadowBranch} ──`);

    if (!runSafe(["rev-parse", "--verify", shadowBranch]).ok) {
      run(["branch", shadowBranch, originalBranch]);
    }

    run(["checkout", shadowBranch]);

    const args = [path.join(SCRIPT_DIR, "shadow-pull.ts"), "-r", remote, "-b", branch];
    if (dryRun) args.push("-n");

    const result = spawnSync("npx", ["tsx", ...args], {
      cwd: SCRIPT_DIR, encoding: "utf8", stdio: "inherit", shell: true, timeout: 120000,
    });

    if (result.status !== 0) {
      console.error(`  ✘ Failed to sync ${remote}/${branch}`);
      failed++;
    }

    run(["checkout", originalBranch]);
  }
}

if (failed > 0) process.exit(1);
