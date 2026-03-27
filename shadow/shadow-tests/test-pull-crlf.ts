import { createTestEnv, runCiSync, readShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull handles files committed with CRLF line endings on the remote.
 *  Simulates a Windows teammate committing files with CRLF. */
export default function run() {
  const env = createTestEnv("pull-crlf");
  try {
    // Disable autocrlf on the remote so CRLF bytes are stored literally
    git("config core.autocrlf false", env.remoteWorking);

    // Create a file with CRLF line endings on the remote
    const crlfContent = "line one\r\nline two\r\nline three\r\n";
    fs.writeFileSync(path.join(env.remoteWorking, "crlf-file.txt"), crlfContent);
    git("add crlf-file.txt", env.remoteWorking);
    git('commit -m "Add CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should succeed regardless of local autocrlf setting
    const r = runCiSync(env);
    assertEqual(r.status, 0, `pull of CRLF file should succeed: ${r.stderr.slice(0, 300)}`);

    // Verify the file exists locally
    const localContent = readShadowFile(env, "crlf-file.txt");
    assertEqual(localContent !== null, true, "CRLF file should exist locally");

    // Now test: remote modifies the CRLF file
    const updatedCrlf = "line one\r\nline two modified\r\nline three\r\n";
    fs.writeFileSync(path.join(env.remoteWorking, "crlf-file.txt"), updatedCrlf);
    git("add crlf-file.txt", env.remoteWorking);
    git('commit -m "Modify CRLF file"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull the modification — this is where CRLF patches often fail
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, `pull of modified CRLF file should succeed: ${r2.stderr.slice(0, 300)}`);
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-crlf");
}
