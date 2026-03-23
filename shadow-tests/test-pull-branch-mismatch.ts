import { createTestEnv, commitOnRemote, runPull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: pulling a branch that differs from the local branch shows a warning.
 */
export default function run() {
  const env = createTestEnv("pull-branch-mismatch");
  try {
    commitOnRemote(env, { "file.ts": "content\n" }, "Add file");

    // Switch local repo to a different branch
    git("checkout -b develop", env.localRepo);

    // Pull remote main while on local develop — should warn
    const r = runPull(env, ["-b", "main"]);
    assertEqual(r.status, 0, "pull should still succeed");

    // Warning should appear in stderr (console.warn goes to stderr)
    const output = r.stdout + r.stderr;
    assertIncludes(output, "Pulling remote branch 'main' while on local branch 'develop'", "should warn about branch mismatch");
    assertIncludes(output, "git checkout -b main", "should suggest creating local branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-branch-mismatch");
}
