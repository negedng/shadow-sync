import { execSync } from "child_process";
import { createTestEnv, commitOnRemote, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: local branch + merge workflow, then export replays commits to external. */
export default function run() {
  const env = createTestEnv("push-branch-merge");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base content\n" }, "Add base");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Create a feature branch
    git("checkout -b feature/test-branch", env.localRepo);

    // Make two commits on the branch modifying the subdir
    const fs = require("fs");
    const path = require("path");

    const filePath = path.join(env.localRepo, env.subdir, "feature.ts");
    fs.writeFileSync(filePath, "export const v1 = true;\n");
    git(`add ${env.subdir}/feature.ts`, env.localRepo);
    git('commit -m "Branch commit 1: add feature.ts"', env.localRepo);

    fs.writeFileSync(filePath, "export const v1 = true;\nexport const v2 = true;\n");
    git(`add ${env.subdir}/feature.ts`, env.localRepo);
    git('commit -m "Branch commit 2: extend feature.ts"', env.localRepo);

    // Merge back to main with --no-ff
    git("checkout main", env.localRepo);
    git('merge feature/test-branch --no-ff -m "Merge feature/test-branch"', env.localRepo);

    // Export replays commits to external's shadow branch
    const r2 = runPush(env, "Add feature from branch merge");
    assertEqual(r2.status, 0, "push should succeed");
    assertIncludes(r2.stdout, "Done", "should report done");

    // Verify external shadow branch has the merged content
    assertEqual(
      readExternalShadowFile(env, "feature.ts"),
      "export const v1 = true;\nexport const v2 = true;\n",
      "feature.ts should have final merged content on external shadow branch",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-branch-merge");
}
