import { createTestEnv, commitOnRemote, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: -d flag allows specifying a different subdirectory than the remote name. */
export default function run() {
  const env = createTestEnv("push-dir-flag", "custom-dir");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runCiSync(env);
    mergeShadow(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add a file locally under custom-dir
    const filePath = path.join(env.localRepo, "custom-dir", "local-file.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const local = true;\n");
    git('add custom-dir/local-file.ts', env.localRepo);
    git('commit -m "Add local file"', env.localRepo);

    // Push — the config already maps team → custom-dir
    const r2 = runPush(env, "Push with custom dir");
    assertEqual(r2.status, 0, "push with -d flag should succeed");

    // Verify on shadow branch
    assertEqual(
      readExternalShadowFile(env, "local-file.ts"),
      "export const local = true;\n",
      "file should appear on shadow branch",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-dir-flag");
}
