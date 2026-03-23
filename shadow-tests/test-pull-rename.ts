import { createTestEnv, commitOnRemote, runPull, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: pull handles file renames on the remote. With -M, git diff produces
 *  rename entries. The content should arrive correctly regardless. */
export default function run() {
  const env = createTestEnv("pull-rename");
  try {
    // Teammate creates a file
    commitOnRemote(env, { "old-name.ts": "export const x = 1;\n" }, "Add old-name.ts");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    assertEqual(readLocalFile(env, "old-name.ts"), "export const x = 1;\n", "old file pulled");

    // Teammate renames the file (git mv)
    const { execSync } = require("child_process");
    execSync("git mv old-name.ts new-name.ts", {
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: "pipe",
    });
    execSync('git commit -m "Rename old-name.ts to new-name.ts"', {
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: "pipe",
    });
    execSync("git push origin main", {
      cwd: env.remoteWorking,
      encoding: "utf8",
      stdio: "pipe",
    });

    // Pull the rename
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "pull of rename should succeed");

    // Old file should be gone, new file should exist with same content
    assertEqual(readLocalFile(env, "old-name.ts"), null, "old file should be deleted");
    assertEqual(readLocalFile(env, "new-name.ts"), "export const x = 1;\n", "new file should have content");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-rename");
}
