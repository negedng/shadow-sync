import { createTestEnv, runCiSync } from "./harness";
import { assertIncludes } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull warns when remote contains a submodule entry.
 *  We simulate a submodule by adding a mode 160000 entry directly to the index. */
export default function run() {
  const env = createTestEnv("pull-submodule-warn");
  try {
    // A submodule is stored as a commit hash in the tree with mode 160000.
    // We use a fake commit hash and add it directly to the index.
    const fakeCommitHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    git(`update-index --add --cacheinfo 160000,${fakeCommitHash},vendor/lib`, env.remoteWorking);

    // Also add a .gitmodules file to make it more realistic
    fs.writeFileSync(
      path.join(env.remoteWorking, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n'
    );
    git("add .gitmodules", env.remoteWorking);
    git('commit -m "Add submodule"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should warn about the submodule
    const r = runCiSync(env);
    assertIncludes(r.stderr, "SUBMODULE", "should warn about submodule");
    assertIncludes(r.stderr, "vendor/lib", "should mention the submodule path");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-submodule-warn");
}
