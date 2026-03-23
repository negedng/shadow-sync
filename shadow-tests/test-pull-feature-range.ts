import { createTestEnv, commitOnRemote, runPull, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: pulling a feature branch only mirrors branch-specific commits,
 * not the entire main history.
 */
export default function run() {
  const env = createTestEnv("pull-feature-range");
  try {
    // Make commits on main (these should NOT be pulled when targeting the feature branch)
    commitOnRemote(env, { "main1.ts": "main1\n" }, "Add main1");
    commitOnRemote(env, { "main2.ts": "main2\n" }, "Add main2");

    // Create feature branch on remote with 2 additional commits
    git("checkout -b feature/range-test", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat1.ts"), "feat1\n");
    git("add feat1.ts", env.remoteWorking);
    git('commit -m "Add feat1 on branch"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat2.ts"), "feat2\n");
    git("add feat2.ts", env.remoteWorking);
    git('commit -m "Add feat2 on branch"', env.remoteWorking);
    git("push origin feature/range-test", env.remoteWorking);

    // Locally create the same branch and pull from it
    git("checkout -b feature/range-test", env.localRepo);
    git(`fetch ${env.remoteName}`, env.localRepo);

    const r = runPull(env, ["-b", "feature/range-test"]);
    assertEqual(r.status, 0, "pull from feature branch should succeed");
    assertIncludes(r.stdout, "Feature branch detected", "should detect feature branch");
    // Only the 2 feature commits should be mirrored, not the 2 main commits
    assertIncludes(r.stdout, "2 new commit(s) to mirror", "should find exactly 2 commits");

    // Feature files should exist
    assertEqual(readLocalFile(env, "feat1.ts"), "feat1\n", "feat1.ts should be pulled");
    assertEqual(readLocalFile(env, "feat2.ts"), "feat2\n", "feat2.ts should be pulled");

    // Main-only files should NOT exist (they weren't in the feature range)
    assertEqual(readLocalFile(env, "main1.ts"), null, "main1.ts should not be pulled");
    assertEqual(readLocalFile(env, "main2.ts"), null, "main2.ts should not be pulled");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-feature-range");
}
