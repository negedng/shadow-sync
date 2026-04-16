import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readShadowFile, readExternalShadowFile, getExternalShadowLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated pull-branches test. Exercises branch-level sync concerns.
 * Uses two envs because custom-branch-prefix is a whole-env setting:
 *
 *   env1 (default "shadow" prefix):
 *     1. feature-branch — simple feature branch replays to shadow/<sub>/<branch>
 *     2. feature-range — feature branch pushed after main commits, feature
 *        shadow holds only branch-specific content
 *     3. orphan-branch — no shared ancestry with main
 *
 *   env2 (custom "shd" prefix): custom-branch-prefix round-trip (pull + push)
 */
export default function run() {
  // ── env1: default prefix, three branch scenarios ────────────────────
  const env1 = createTestEnv("pull-branches-default");
  try {
    // phase 1: feature-branch
    git("checkout -b feature/cool-thing", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "cool.ts"), "export const cool = true;\n");
    git("add cool.ts", env1.remoteWorking);
    git('commit -m "Add cool feature"', env1.remoteWorking);
    git("push origin feature/cool-thing", env1.remoteWorking);

    const r1 = runCiSync(env1);
    assertEqual(r1.status, 0, "[phase 1: feature-branch] should succeed");
    git("fetch origin", env1.localRepo);
    assertEqual(
      git("branch -r", env1.localRepo).includes("origin/shadow/frontend/feature/cool-thing"),
      true, "[phase 1] feature shadow branch exists",
    );
    const cool = git("show \"origin/shadow/frontend/feature/cool-thing:frontend/cool.ts\"", env1.localRepo);
    assertEqual(cool, "export const cool = true;", "[phase 1] cool.ts on feature shadow");

    // phase 2: feature-range — commits on main, then separate commits on a feature branch
    git("checkout main", env1.remoteWorking);
    commitOnRemote(env1, { "main1.ts": "main1\n" }, "Add main1");
    commitOnRemote(env1, { "main2.ts": "main2\n" }, "Add main2");

    git("checkout -b feature/range-test", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "feat1.ts"), "feat1\n");
    git("add feat1.ts", env1.remoteWorking);
    git('commit -m "Add feat1 on branch"', env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "feat2.ts"), "feat2\n");
    git("add feat2.ts", env1.remoteWorking);
    git('commit -m "Add feat2 on branch"', env1.remoteWorking);
    git("push origin feature/range-test", env1.remoteWorking);

    const r2 = runCiSync(env1);
    assertEqual(r2.status, 0, "[phase 2: feature-range] should succeed");
    assertIncludes(r2.stdout, "Replayed", "[phase 2] should replay");
    git("fetch origin", env1.localRepo);
    const f1 = git("show \"origin/shadow/frontend/feature/range-test:frontend/feat1.ts\"", env1.localRepo);
    const f2 = git("show \"origin/shadow/frontend/feature/range-test:frontend/feat2.ts\"", env1.localRepo);
    assertEqual(f1, "feat1", "[phase 2] feat1 on feature shadow");
    assertEqual(f2, "feat2", "[phase 2] feat2 on feature shadow");

    // phase 3: orphan-branch (no shared history with main)
    git("checkout main", env1.remoteWorking);
    git("checkout --orphan docs", env1.remoteWorking);
    git("rm -rf .", env1.remoteWorking);
    fs.writeFileSync(path.join(env1.remoteWorking, "doc.md"), "# docs\n");
    git("add doc.md", env1.remoteWorking);
    git('commit -m "Orphan docs root"', env1.remoteWorking);
    git("push origin docs", env1.remoteWorking);
    git("checkout main", env1.remoteWorking);

    const r3 = runCiSync(env1);
    assertEqual(r3.status, 0, "[phase 3: orphan-branch] should not crash");
    git("fetch origin", env1.localRepo);
    assertEqual(
      git("branch -r", env1.localRepo).includes(`origin/shadow/${env1.subdir}/docs`),
      true, "[phase 3] orphan shadow branch exists",
    );
    const tip = git(`log -1 --format=%s origin/shadow/${env1.subdir}/docs`, env1.localRepo);
    if (!tip) throw new Error("[phase 3] orphan shadow branch should have a commit");
  } finally {
    env1.cleanup();
  }

  // ── env2: custom prefix "shd" — round-trip ──────────────────────────
  const env2 = createTestEnv("pull-branches-custom", "frontend", "shd");
  try {
    // Pull side: external commit with custom prefix
    commitOnRemote(env2, { "hello.txt": "from external\n" }, "Add hello");
    const r4 = runCiSync(env2);
    assertEqual(r4.status, 0, "[phase 4: custom-prefix pull] should succeed");
    assertIncludes(r4.stdout, "shd/frontend/main", "[phase 4] output references custom prefix");
    mergeShadow(env2);
    assertEqual(readShadowFile(env2, "hello.txt"), "from external\n", "[phase 4] file on custom-prefix shadow");

    // Push side
    commitOnLocal(env2, { "feature.ts": "export const x = 1;\n" }, "Add feature");
    const r5 = runPush(env2, "Push feature");
    assertEqual(r5.status, 0, "[phase 5: custom-prefix push] should succeed");
    assertIncludes(r5.stdout, "shd/frontend/main", "[phase 5] push references custom prefix");
    assertEqual(readExternalShadowFile(env2, "feature.ts"), "export const x = 1;\n", "[phase 5] file on external shadow");
    assertIncludes(getExternalShadowLogFull(env2), "Shadow-replayed-", "[phase 5] trailer present");
  } finally {
    env2.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-branches");
}
