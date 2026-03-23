import { createTestEnv, commitOnRemote, runPull, runPush, readRemoteFile, pullRemoteWorking } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: push works when files were committed with CRLF line endings.
 *  We commit a CRLF file with autocrlf=false so the bytes go in as-is. */
export default function run() {
  const env = createTestEnv("push-crlf");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    runPull(env);

    // Disable autocrlf so CRLF is stored as-is in the object store
    git("config core.autocrlf false", env.localRepo);

    // Create a file with CRLF line endings and commit it
    const crlfContent = "line one\r\nline two\r\n";
    const filePath = path.join(env.localRepo, env.subdir, "crlf-local.txt");
    fs.writeFileSync(filePath, crlfContent);
    git(`add ${env.subdir}/crlf-local.txt`, env.localRepo);
    git('commit -m "Add CRLF file"', env.localRepo);

    // Push — should succeed
    const r = runPush(env, "Push CRLF file");
    assertEqual(r.status, 0, `push of CRLF file should succeed: ${r.stderr.slice(0, 300)}`);

    // Verify file exists on remote
    pullRemoteWorking(env);
    const remoteContent = readRemoteFile(env, "crlf-local.txt");
    assertEqual(remoteContent !== null, true, "CRLF file should be on remote");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-crlf");
}
