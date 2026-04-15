import { execSync } from "child_process";
import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual } from "./assert";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: merging shadow into local after an export does NOT delete
 * non-dir files. This is the bug that caused scripts, config, and
 * tests to be wiped from the working tree.
 */
export default function run() {
  const env = createTestEnv("push-preserve-non-dir");
  try {
    // Verify mono.txt exists at repo root (created by harness)
    const monoPath = path.join(env.localRepo, "mono.txt");
    assertEqual(fs.existsSync(monoPath), true, "mono.txt should exist before export");

    // Add a root-level file to make the test more realistic
    fs.writeFileSync(path.join(env.localRepo, "root-config.json"), '{"key":"value"}\n');
    git("add root-config.json", env.localRepo);
    git('commit -m "Add root config"', env.localRepo);

    // Commit a frontend file and export
    commitOnLocal(env, { "app.ts": "export const app = true;\n" }, "Add app.ts");
    const r1 = runPush(env, "Export app.ts");
    assertEqual(r1.status, 0, "export should succeed");

    // Now simulate external changes arriving via CI sync
    commitOnRemote(env, { "external.ts": "from external\n" }, "Add external.ts");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "ci-sync should succeed");

    // Merge shadow into local — this is where the bug was
    mergeShadow(env);

    // Non-dir files must survive
    assertEqual(fs.existsSync(monoPath), true, "mono.txt must survive shadow merge");
    assertEqual(
      fs.existsSync(path.join(env.localRepo, "root-config.json")),
      true,
      "root-config.json must survive shadow merge",
    );

    // Verify the shadow scripts are still there (harness copies them to localRepo)
    assertEqual(
      fs.existsSync(path.join(env.localRepo, "shadow-common.ts")),
      true,
      "shadow-common.ts must survive shadow merge",
    );

    // Dir files should have the external change
    assertEqual(
      fs.existsSync(path.join(env.localRepo, env.subdir, "external.ts")),
      true,
      "external.ts should appear under dir/ after merge",
    );

    // A subsequent export should still work
    commitOnLocal(env, { "local2.ts": "local2\n" }, "Add local2.ts");
    const r3 = runPush(env, "Export after safe merge");
    assertEqual(r3.status, 0, "export after safe merge should succeed");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-preserves-non-dir");
}
