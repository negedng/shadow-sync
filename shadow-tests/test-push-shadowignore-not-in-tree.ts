import { execSync } from "child_process";
import { createTestEnv, commitOnLocal, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: shadowignored files never appear in ANY commit tree on the shadow branch.
 *
 * With merge-based export, the commit has HEAD as a parent. This test walks
 * every commit reachable via --first-parent on the shadow branch and verifies
 * the ignored file doesn't appear in any of their trees. (The full merge
 * ancestry includes main's commits, but the external repo only receives the
 * shadow branch — so we check what matters: the shadow branch's own trees.)
 */
export default function run() {
  const env = createTestEnv("push-ignore-tree");
  try {
    // Commit .shadowignore alongside source files (under subdir).
    // The replay engine discovers it from the source commit's tree.
    commitOnLocal(env, {
      ".shadowignore": "secret.env\n",
      "app.ts": "export const app = true;\n",
      "secret.env": "API_KEY=supersecret\n",
    }, "Add app.ts, secret.env, and .shadowignore");

    // Export
    const r1 = runPush(env, "First export");
    assertEqual(r1.status, 0, "first push should succeed");

    // Verify secret.env is NOT on shadow branch
    assertEqual(
      readExternalShadowFile(env, "secret.env"),
      null,
      "secret.env should not be on shadow branch",
    );
    // Verify app.ts IS there
    assertEqual(
      readExternalShadowFile(env, "app.ts"),
      "export const app = true;\n",
      "app.ts should be on shadow branch",
    );

    // Make another export to create multiple commits
    commitOnLocal(env, { "utils.ts": "export const util = true;\n" }, "Add utils.ts");
    const r2 = runPush(env, "Second export");
    assertEqual(r2.status, 0, "second push should succeed");

    // Walk ALL commits on the external's shadow branch
    // and verify secret.env never appears in any tree.
    git(`fetch ${env.remoteName} shadow/${env.subdir}/main`, env.localRepo);
    const commits = git(
      `log ${env.remoteName}/shadow/${env.subdir}/main --format=%H`,
      env.localRepo,
    ).split("\n").filter(Boolean);

    for (const hash of commits) {
      const tree = git(`ls-tree -r --name-only ${hash}`, env.localRepo);
      const files = tree.split("\n").filter(Boolean);
      const hasSecret = files.some(f => f.endsWith("secret.env"));
      assertEqual(
        hasSecret,
        false,
        `secret.env must not appear in tree of commit ${hash.slice(0, 8)}`,
      );
    }
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-shadowignore-not-in-tree");
}
