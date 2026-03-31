import { execSync } from "child_process";
import { createTestEnv, commitOnLocal, runPush } from "./harness";
import { assertEqual } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: export creates a merge commit with two parents (shadow tip + HEAD). */
export default function run() {
  const env = createTestEnv("push-merge-ancestry");
  try {
    // Commit a file locally
    commitOnLocal(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");

    // Export to shadow branch
    const r = runPush(env, "Export app.ts");
    assertEqual(r.status, 0, "push should succeed");

    // Fetch and inspect the shadow branch commit
    git("fetch origin shadow/frontend/main", env.localRepo);
    const parentCount = git(
      "rev-list --parents -1 origin/shadow/frontend/main",
      env.localRepo,
    ).split(/\s+/).length - 1; // first token is the commit itself

    assertEqual(parentCount, 2, "export commit should be a merge commit with 2 parents");

    // Verify one parent is the local HEAD
    const head = git("rev-parse HEAD", env.localRepo);
    const parents = git(
      "rev-list --parents -1 origin/shadow/frontend/main",
      env.localRepo,
    ).split(/\s+/).slice(1);
    assertEqual(parents.includes(head), true, "one parent should be the local HEAD");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-ancestry");
}
