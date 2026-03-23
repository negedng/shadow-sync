import { createTestEnv, runPull } from "./harness";
import { assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull warns when remote has a .gitattributes with LFS filters. */
export default function run() {
  const env = createTestEnv("pull-lfs-warn");
  try {
    // Add a .gitattributes with LFS filter to the remote
    const attrsContent = "*.bin filter=lfs diff=lfs merge=lfs -text\n";
    fs.writeFileSync(path.join(env.remoteWorking, ".gitattributes"), attrsContent);
    git("add .gitattributes", env.remoteWorking);
    git('commit -m "Add LFS gitattributes"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull — should warn about LFS
    const r = runPull(env);
    assertIncludes(r.stderr, "GIT_LFS", "should warn about LFS");
    assertIncludes(r.stderr, "pointer", "should mention pointer files");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-lfs-warn");
}
