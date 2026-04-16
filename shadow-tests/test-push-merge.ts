import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated push-merge test. Merge scenarios pushing local history to
 * the external shadow branch.
 *
 *   env1:
 *     1. merge-ancestry — first push: shadow commit has 1 parent = seed tip
 *     2. branch-merge — local feature branch merged back, push replays
 *     3. merge-with-external-changes — round-trip: ext→ci-sync→merge→push
 *     4. preserves-non-dir — root-level files survive mergeShadow
 *
 *   env2 (isolated because it asserts seed-tip as unmapped first parent):
 *     5. merge-unmapped-parent — merge of an orphan branch on local produces
 *        a 2-parent shadow commit with the seed tip as first parent
 */
export default function run() {
  // ── env1: four push-merge phases sharing one env ────────────────────
  const env1 = createTestEnv("push-merge-env1");
  try {
    // ── phase 1: merge-ancestry (must be first push on a clean shadow) ─
    commitOnLocal(env1, { "app.ts": "console.log('hello');\n" }, "Add app.ts");
    const r1 = runPush(env1, "Export app.ts");
    assertEqual(r1.status, 0, "[phase 1: merge-ancestry] push should succeed");

    git(`fetch ${env1.remoteName} shadow/${env1.subdir}/main`, env1.localRepo);
    const parentLine1 = git(`rev-list --parents -1 ${env1.remoteName}/shadow/${env1.subdir}/main`, env1.localRepo);
    const parents1 = parentLine1.split(/\s+/).filter(Boolean);
    assertEqual(parents1.length - 1, 1, "[phase 1] forwarded commit has exactly 1 parent");
    const seedTip = git(`rev-parse ${env1.remoteName}/main`, env1.localRepo);
    assertEqual(parents1[1], seedTip, "[phase 1] parent is the external seed tip");
    const msg1 = git(`log -1 --format=%B ${env1.remoteName}/shadow/${env1.subdir}/main`, env1.localRepo);
    assertIncludes(msg1, "Shadow-replayed-", "[phase 1] commit has replay trailer");

    // ── phase 2: local branch + merge → push ────────────────────────────
    git("checkout -b feature/test-branch", env1.localRepo);
    const featPath = path.join(env1.localRepo, env1.subdir, "feature.ts");
    fs.writeFileSync(featPath, "export const v1 = true;\n");
    git(`add ${env1.subdir}/feature.ts`, env1.localRepo);
    git('commit -m "Branch commit 1: add feature.ts"', env1.localRepo);
    fs.writeFileSync(featPath, "export const v1 = true;\nexport const v2 = true;\n");
    git(`add ${env1.subdir}/feature.ts`, env1.localRepo);
    git('commit -m "Branch commit 2: extend feature.ts"', env1.localRepo);
    git("checkout main", env1.localRepo);
    git('merge feature/test-branch --no-ff -m "Merge feature/test-branch"', env1.localRepo);

    const r2 = runPush(env1, "Add feature from branch merge");
    assertEqual(r2.status, 0, "[phase 2: branch-merge] push should succeed");
    assertIncludes(r2.stdout, "Done", "[phase 2] reports done");
    assertEqual(
      readExternalShadowFile(env1, "feature.ts"),
      "export const v1 = true;\nexport const v2 = true;\n",
      "[phase 2] merged feature.ts on shadow",
    );

    // ── phase 3: merge-with-external-changes ────────────────────────────
    commitOnRemote(env1, { "external.ts": "from external team\n" }, "Add external.ts");
    const r3a = runCiSync(env1);
    assertEqual(r3a.status, 0, "[phase 3: external-changes] ci-sync should succeed");
    mergeShadow(env1);
    commitOnLocal(env1, { "local.ts": "from local team\n" }, "Add local.ts");
    const r3b = runPush(env1, "Export local.ts");
    assertEqual(r3b.status, 0, "[phase 3] push should succeed");
    assertEqual(readExternalShadowFile(env1, "local.ts"), "from local team\n", "[phase 3] local.ts on shadow");

    // Second round
    commitOnRemote(env1, { "external2.ts": "second external file\n" }, "Add external2.ts");
    const r3c = runCiSync(env1);
    assertEqual(r3c.status, 0, "[phase 3] second ci-sync should succeed");
    mergeShadow(env1);
    commitOnLocal(env1, { "local2.ts": "second local file\n" }, "Add local2.ts");
    const r3d = runPush(env1, "Export local2.ts");
    assertEqual(r3d.status, 0, "[phase 3] second push should succeed");
    assertEqual(readExternalShadowFile(env1, "local.ts"), "from local team\n", "[phase 3] local.ts persists");
    assertEqual(readExternalShadowFile(env1, "local2.ts"), "second local file\n", "[phase 3] local2.ts on shadow");

    // ── phase 4: preserves-non-dir ──────────────────────────────────────
    // mono.txt was created by harness at repo root. Verify it's still there.
    const monoPath = path.join(env1.localRepo, "mono.txt");
    assertEqual(fs.existsSync(monoPath), true, "[phase 4: non-dir] mono.txt present before test");
    // Add a second root-level file
    fs.writeFileSync(path.join(env1.localRepo, "root-config.json"), '{"key":"value"}\n');
    git("add root-config.json", env1.localRepo);
    git('commit -m "Add root config"', env1.localRepo);

    commitOnLocal(env1, { "app2.ts": "export const app2 = true;\n" }, "Add app2.ts");
    const r4a = runPush(env1, "Export app2.ts");
    assertEqual(r4a.status, 0, "[phase 4] push should succeed");

    // External changes → ci-sync → mergeShadow. Root files must survive.
    commitOnRemote(env1, { "external3.ts": "ext3\n" }, "Add external3.ts");
    const r4b = runCiSync(env1);
    assertEqual(r4b.status, 0, "[phase 4] ci-sync should succeed");
    mergeShadow(env1);

    assertEqual(fs.existsSync(monoPath), true, "[phase 4] mono.txt survives mergeShadow");
    assertEqual(fs.existsSync(path.join(env1.localRepo, "root-config.json")), true, "[phase 4] root-config.json survives");
    assertEqual(fs.existsSync(path.join(env1.localRepo, env1.subdir, "external3.ts")), true, "[phase 4] external3.ts arrives under subdir");

    commitOnLocal(env1, { "local3.ts": "local3\n" }, "Add local3.ts");
    const r4c = runPush(env1, "Export after safe merge");
    assertEqual(r4c.status, 0, "[phase 4] subsequent push should succeed");
  } finally {
    env1.cleanup();
  }

  // ── env2: merge-unmapped-parent (isolated — first-parent ancestry ───
  //         depends on starting from an unpushed env) ──────────────────
  const env2 = createTestEnv("push-merge-unmapped");
  try {
    const sub = env2.subdir;
    const seedTip2 = git(`rev-parse ${env2.remoteName}/main`, env2.localRepo);

    // Create an orphan branch with unrelated history
    git("checkout --orphan orphan", env2.localRepo);
    git("rm -rf --cached .", env2.localRepo);
    for (const f of fs.readdirSync(env2.localRepo)) {
      if (f === ".git") continue;
      fs.rmSync(path.join(env2.localRepo, f), { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(env2.localRepo, sub), { recursive: true });
    fs.writeFileSync(path.join(env2.localRepo, sub, "orphan.ts"), "from orphan\n");
    git(`add ${sub}/orphan.ts`, env2.localRepo);
    git('commit -m "C_orphan on unrelated branch"', env2.localRepo);

    git("checkout main", env2.localRepo);
    git("merge --allow-unrelated-histories --no-commit --no-ff orphan", env2.localRepo);
    fs.writeFileSync(path.join(env2.localRepo, sub, "merge-marker.ts"), "merge marker\n");
    git(`add ${sub}/merge-marker.ts`, env2.localRepo);
    git('commit -m "C_merge bring orphan into main"', env2.localRepo);

    const r5 = runPush(env2);
    assertEqual(r5.status, 0, "[phase 5: unmapped-parent] push should succeed");

    const shadowBranch2 = `${env2.branchPrefix}/${sub}/main`;
    git(`fetch ${env2.remoteName} ${shadowBranch2}`, env2.localRepo);
    const parentLine5 = git(`log -1 --format=%P ${env2.remoteName}/${shadowBranch2}`, env2.localRepo);
    const parents5 = parentLine5.split(/\s+/).filter(Boolean);
    assertEqual(parents5.length, 2, `[phase 5] replayed merge has 2 parents, got ${parents5.length}`);
    assertEqual(parents5[0], seedTip2, "[phase 5] unmapped parent grafted onto external seed tip");
    assertEqual(readExternalShadowFile(env2, "orphan.ts"), "from orphan\n", "[phase 5] orphan.ts on shadow");
    assertEqual(readExternalShadowFile(env2, "merge-marker.ts"), "merge marker\n", "[phase 5] merge-marker.ts on shadow");
  } finally {
    env2.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge");
}
