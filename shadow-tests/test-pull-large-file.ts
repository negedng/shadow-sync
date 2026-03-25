import { createTestEnv, runCiSync, readShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull handles a file larger than Node's default 1 MB spawnSync buffer.
 *  This verifies the maxBuffer fix — without it, the diff is silently truncated. */
export default function run() {
  const env = createTestEnv("pull-large-file");
  try {
    // Create a ~1.5 MB text file on the remote (exceeds default 1MB maxBuffer)
    const lineCount = 30000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`line ${i}: ${"x".repeat(40)} padding to make this file large enough\n`);
    }
    const largeContent = lines.join("");

    const remotePath = path.join(env.remoteWorking, "large-file.txt");
    fs.writeFileSync(remotePath, largeContent);
    git("add large-file.txt", env.remoteWorking);
    git('commit -m "Add large file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should succeed and produce the complete file
    const r = runCiSync(env);
    assertEqual(r.status, 0, `pull should succeed, stderr: ${r.stderr.slice(0, 500)}`);

    const localContent = readShadowFile(env, "large-file.txt");
    assertEqual(localContent !== null, true, "large file should exist locally");
    assertEqual(
      localContent!.length,
      largeContent.length,
      `file size should match (expected ${largeContent.length}, got ${localContent!.length})`,
    );
    // Verify first and last lines to confirm no truncation
    assertEqual(
      localContent!.startsWith("line 0:"),
      true,
      "first line should be intact",
    );
    assertEqual(
      localContent!.includes(`line ${lineCount - 1}:`),
      true,
      "last line should be intact (no truncation)",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-large-file");
}
