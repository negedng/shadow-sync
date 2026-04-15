import { createTestEnv, runCiSync, getShadowAuthors } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Test: ci-sync preserves the original author name and email from external commits. */
export default function run() {
  const env = createTestEnv("pull-author");
  try {
    const workDir = env.remoteWorking;

    // Make a commit with a specific author on the remote
    fs.writeFileSync(path.join(workDir, "alice.ts"), "// Alice's file\n");
    execSync(`git add alice.ts`, { cwd: workDir, encoding: "utf8", stdio: "pipe" });
    execSync(`git commit --author="Alice External <alice@external.com>" -m "Alice commit"`, {
      cwd: workDir, encoding: "utf8", stdio: "pipe",
    });

    // Make another commit with a different author
    fs.writeFileSync(path.join(workDir, "bob.ts"), "// Bob's file\n");
    execSync(`git add bob.ts`, { cwd: workDir, encoding: "utf8", stdio: "pipe" });
    execSync(`git commit --author="Bob Contributor <bob@contributor.org>" -m "Bob commit"`, {
      cwd: workDir, encoding: "utf8", stdio: "pipe",
    });

    execSync(`git push origin main`, { cwd: workDir, encoding: "utf8", stdio: "pipe" });

    // CI sync should replay them preserving authorship
    const r = runCiSync(env);
    assertEqual(r.status, 0, "ci-sync should succeed");

    const authors = getShadowAuthors(env);
    assertIncludes(authors, "Bob Contributor <bob@contributor.org>", "Bob's authorship should be preserved");
    assertIncludes(authors, "Alice External <alice@external.com>", "Alice's authorship should be preserved");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-author");
}
