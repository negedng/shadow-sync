import { createTestEnv, runPull, readLocalFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull handles file mode changes (e.g., chmod +x on Linux).
 *  We simulate this by adding an executable file to the remote index. */
export default function run() {
  const env = createTestEnv("pull-filemode");
  try {
    // Enable filemode on the remote to simulate a Linux environment
    git("config core.filemode true", env.remoteWorking);

    // Create a regular file first
    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Add script.sh"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull the initial file
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    assertEqual(readLocalFile(env, "script.sh"), "#!/bin/bash\necho hello\n", "script content");

    // Now change the mode to executable using update-index
    git("update-index --chmod=+x script.sh", env.remoteWorking);
    git('commit -m "Make script.sh executable"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull the mode change — should not fail even on Windows
    const r2 = runPull(env);
    assertEqual(r2.status, 0, `pull of mode change should succeed: ${r2.stderr.slice(0, 300)}`);

    // Content should be unchanged
    assertEqual(readLocalFile(env, "script.sh"), "#!/bin/bash\necho hello\n", "content after mode change");

    // Now modify content AND mode simultaneously
    fs.writeFileSync(path.join(env.remoteWorking, "script.sh"), "#!/bin/bash\necho hello world\n");
    git("add script.sh", env.remoteWorking);
    git('commit -m "Update script content"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r3 = runPull(env);
    assertEqual(r3.status, 0, `pull of content+mode should succeed: ${r3.stderr.slice(0, 300)}`);
    assertEqual(readLocalFile(env, "script.sh"), "#!/bin/bash\necho hello world\n", "updated content");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-filemode");
}
