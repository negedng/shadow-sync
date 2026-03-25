import { createTestEnv, commitOnRemote, runPull, runPush } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: push handles binary files correctly. */
export default function run() {
  const env = createTestEnv("push-binary-file");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    runPull(env);

    // Create a binary file locally
    const binaryContent = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
    ]);

    const localBin = path.join(env.localRepo, env.subdir, "image.png");
    fs.writeFileSync(localBin, binaryContent);
    git(`add ${env.subdir}/image.png`, env.localRepo);
    git('commit -m "Add binary image"', env.localRepo);

    // Push
    const r = runPush(env, "Push binary file");
    assertEqual(r.status, 0, "push with binary file should succeed");

    // Verify on shadow branch by extracting the file via git show
    git("fetch origin shadow/frontend/main", env.localRepo);
    const result = execSync(
      `git show origin/shadow/frontend/main:frontend/image.png`,
      { cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"] },
    );
    assertEqual(result.length, binaryContent.length, "binary file size should match");
    assertEqual(
      Buffer.compare(result, binaryContent) === 0,
      true,
      "binary content should match exactly",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-binary-file");
}
