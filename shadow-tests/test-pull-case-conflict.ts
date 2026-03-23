import { createTestEnv, runPull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull detects case conflicts on case-insensitive filesystems.
 *  We create two files differing only in case in the remote's git index. */
export default function run() {
  // This test only applies on case-insensitive platforms
  if (process.platform !== "win32" && process.platform !== "darwin") {
    console.log("  (skipped — only applies on Windows/macOS)");
    return;
  }

  const env = createTestEnv("pull-case-conflict");
  try {
    // Create two files that differ only in case using low-level git index manipulation.
    // We can't do this through the filesystem on Windows, so we use git hash-object + update-index.
    const blob1 = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: "content of README.md\n",
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).stdout.trim();

    const blob2 = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: "content of readme.md\n",
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).stdout.trim();

    // Add both to the index — this is possible even on case-insensitive FS
    // because we're manipulating the index directly
    git(`update-index --add --cacheinfo 100644,${blob1},docs/README.md`, env.remoteWorking);
    git(`update-index --add --cacheinfo 100644,${blob2},docs/readme.md`, env.remoteWorking);
    git('commit -m "Add case-conflicting files"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should refuse with CASE_CONFLICT error
    const r = runPull(env);
    assertEqual(r.status, 1, "pull should fail on case conflict");
    assertIncludes(r.stderr, "CASE_CONFLICT", "should mention case conflict");
    assertIncludes(r.stderr, "README.md", "should mention the conflicting file");
    assertIncludes(r.stderr, "readme.md", "should mention both files");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-case-conflict");
}
