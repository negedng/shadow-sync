import { createTestEnv, commitOnRemote, runPull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull refuses on a shallow clone with a clear error message. */
export default function run() {
  const env = createTestEnv("pull-shallow-clone");
  try {
    // Add a commit so there's something to pull
    commitOnRemote(env, { "file.txt": "content\n" }, "Add file");

    // Convert the local repo into a shallow clone by grafting the history
    // We simulate shallow by creating .git/shallow with the current HEAD
    const head = git("rev-parse HEAD", env.localRepo);
    fs.writeFileSync(path.join(env.localRepo, ".git", "shallow"), head + "\n");

    // Verify it's now considered shallow
    const isShallow = git("rev-parse --is-shallow-repository", env.localRepo);
    assertEqual(isShallow, "true", "repo should be shallow");

    // Pull should refuse
    const r = runPull(env);
    assertEqual(r.status, 1, "pull should fail on shallow clone");
    assertIncludes(r.stderr, "SHALLOW_CLONE", "should mention shallow clone");
    assertIncludes(r.stderr, "unshallow", "should suggest fix");

    // Clean up the shallow file and pull should work
    fs.unlinkSync(path.join(env.localRepo, ".git", "shallow"));
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "pull should succeed after unshallowing");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-shallow-clone");
}
