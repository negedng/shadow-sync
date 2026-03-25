import { createTestEnv, runCiSync } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull warns when remote contains a symlink.
 *  On Windows, git stores symlinks as regular files with the target path,
 *  so we create the symlink entry directly in the git index. */
export default function run() {
  const env = createTestEnv("pull-symlink-warn");
  try {
    // Create a symlink entry in the remote repo using low-level git commands.
    // This works on any platform — we write a blob with the link target
    // and add it to the index with mode 120000.
    const linkTarget = "../config/settings.json";
    const result = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      input: linkTarget,
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const blobHash = result.stdout.trim();

    // Add to index as a symlink (mode 120000)
    git(`update-index --add --cacheinfo 120000,${blobHash},config-link`, env.remoteWorking);
    git('commit -m "Add symlink"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should warn about symlink
    const r = runCiSync(env);
    assertIncludes(r.stderr, "SYMLINK", "should warn about symlink");
    assertIncludes(r.stderr, "config-link", "should mention the symlink path");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-symlink-warn");
}
