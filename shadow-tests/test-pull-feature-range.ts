import { createTestEnv, commitOnRemote, runCiSync } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: CI sync of a feature branch only mirrors branch-specific commits,
 * not the entire main history.
 */
export default function run() {
  const env = createTestEnv("pull-feature-range");
  try {
    // Make commits on main
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

    // CI sync should process both main and feature/range-test
    const r = runCiSync(env);
    assertEqual(r.status, 0, "ci-sync should succeed");
    assertIncludes(r.stdout, "Replayed", "should replay feature branch commits");

    // Feature shadow branch should have feature files but not main-only files
    git("fetch origin", env.localRepo);
    const featureContent1 = execSync(
      'git show "origin/shadow/frontend/feature/range-test:frontend/feat1.ts"',
      { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    assertEqual(featureContent1, "feat1\n", "feat1.ts should be on feature shadow");

    const featureContent2 = execSync(
      'git show "origin/shadow/frontend/feature/range-test:frontend/feat2.ts"',
      { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    assertEqual(featureContent2, "feat2\n", "feat2.ts should be on feature shadow");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-feature-range");
}
