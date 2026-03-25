import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: push with -b flag auto-creates a new shadow branch on origin. */
export default function run() {
  const env = createTestEnv("push-branch-create");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add a file locally
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");

    // Push to a new branch — should create shadow/frontend/feature/new-branch on origin
    const r2 = runPush(env, "Create new branch", ["-b", "feature/new-branch"]);
    assertEqual(r2.status, 0, "push to new branch should succeed");
    assertIncludes(r2.stdout, "Done", "should report done");

    // Verify shadow branch exists on origin
    git("fetch origin", env.localRepo);
    const remoteBranches = git("branch -r", env.localRepo);
    assertIncludes(remoteBranches, "origin/shadow/frontend/feature/new-branch", "shadow branch should exist on origin");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-branch-create");
}
