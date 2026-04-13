import { execSync } from "child_process";
import { createTestEnv, commitOnLocal, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: export creates commits on the external's shadow branch with proper ancestry. */
export default function run() {
  const env = createTestEnv("push-merge-ancestry");
  try {
    // Commit a file locally
    commitOnLocal(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");

    // Export to external's shadow branch
    const r = runPush(env, "Export app.ts");
    assertEqual(r.status, 0, "push should succeed");

    // Fetch the external's shadow branch and check ancestry
    git(`fetch ${env.remoteName} shadow/main`, env.localRepo);
    const parentCount = git(
      `rev-list --parents -1 ${env.remoteName}/shadow/main`,
      env.localRepo,
    ).split(/\s+/).length - 1;

    // Forwarded commit should have 1 parent (grafted onto seed hash)
    assertEqual(parentCount, 1, "forwarded commit should have 1 parent (seed)");

    // The parent should be the external seed hash (the tip of external/main at seed time)
    const parent = git(
      `rev-list --parents -1 ${env.remoteName}/shadow/main`,
      env.localRepo,
    ).split(/\s+/)[1];
    const seedTip = git(`rev-parse ${env.remoteName}/main`, env.localRepo);
    assertEqual(parent, seedTip, "parent should be the external seed hash");

    // Commit message should have the forward trailer
    const msg = git(`log -1 --format=%B ${env.remoteName}/shadow/main`, env.localRepo);
    assertIncludes(msg, "Shadow-forwarded-from:", "commit should have forward trailer");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-ancestry");
}
