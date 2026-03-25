import { createTestEnv, runCiSync } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: CI sync handles feature branches on the external remote. */
export default function run() {
  const env = createTestEnv("pull-feature-branch");
  try {
    // Teammate creates a feature branch and commits to it
    git("checkout -b feature/cool-thing", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "cool.ts"), "export const cool = true;\n");
    git("add cool.ts", env.remoteWorking);
    git('commit -m "Add cool feature"', env.remoteWorking);
    git("push origin feature/cool-thing", env.remoteWorking);

    // CI sync should create shadow/frontend/feature/cool-thing
    const r = runCiSync(env);
    assertEqual(r.status, 0, "ci-sync should succeed");

    // Verify the feature branch shadow exists and has the file
    git("fetch origin", env.localRepo);
    const branches = git("branch -r", env.localRepo);
    assertEqual(
      branches.includes("origin/shadow/frontend/feature/cool-thing"),
      true,
      "feature branch shadow should exist on origin",
    );

    // Verify file content on the feature shadow branch
    const content = execSync(
      'git show "origin/shadow/frontend/feature/cool-thing:frontend/cool.ts"',
      { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    assertEqual(content, "export const cool = true;\n", "feature file should be on shadow branch");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-feature-branch");
}
