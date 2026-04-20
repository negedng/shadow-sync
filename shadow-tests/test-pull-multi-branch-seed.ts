import { createTestEnv, commitOnRemote, runCiSync, runPush, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Pre-seed multi-branch scenario: at seed time a and b already have two
 * divergent branches (main and client-x). Each branch gets its own seed.
 *
 * Exercises:
 *   1. Two seeds for the same pair — replay respects both boundaries.
 *   2. Each branch's shadow lands on its corresponding a-side branch (seed
 *      provides a valid merge base for `git merge origin/shadow/<pair>/<b>`).
 *   3. Pre-seed, a-side-only content (a-only.ts on client-x) is preserved
 *      through the merge — it is not touched by shadow replay.
 *   4. After both branches are live, a cross-branch merge on b (client-x
 *      into main) replays onto shadow/<pair>/main with parents bridging
 *      both branch histories, and merges cleanly into a/main.
 *   5. Extending to four more pre-seed branches (f1..f4): cross-branch
 *      merges on BOTH sides (a merges f1+f2 into a/main, b merges f3+f4
 *      into b/main), then sync round-trips so every feature's post-seed
 *      content reaches both mains.
 */
export default function run() {
  const env = createTestEnv("pull-multi-branch-seed");
  try {
    // ── phase 1: bring client-x into existence on both sides (pre-seed) ──
    // b side: branch off main, add b-only pre-seed commits.
    git("checkout -b client-x", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "client.ts"), "// client code\n");
    git("add client.ts", env.remoteWorking);
    git('commit -m "client.ts on b/client-x"', env.remoteWorking);
    git("push origin client-x", env.remoteWorking);
    const bClientTipAtSeed = git("rev-parse client-x", env.remoteWorking);

    // a side: branch off main, add a-only pre-seed content under frontend/.
    // This file must survive the merge — it never exists on b.
    git("fetch team", env.localRepo);
    git("checkout -b client-x main", env.localRepo);
    fs.mkdirSync(path.join(env.localRepo, env.subdir), { recursive: true });
    fs.writeFileSync(path.join(env.localRepo, env.subdir, "a-only.ts"), "// a-side only\n");
    git(`add ${env.subdir}/a-only.ts`, env.localRepo);
    git('commit -m "a-only.ts on a/client-x"', env.localRepo);
    git("push origin client-x", env.localRepo);

    // ── phase 2: seed client-x (second seed for the same pair) ──
    // Simulates shadow-setup.ts pushing a seed commit onto a/client-x
    // with b/client-x's current tip recorded in the trailer.
    git(
      `commit --allow-empty -m "Seed shadow-sync for ${env.subdir}/ from team/client-x" ` +
      `-m "Shadow-seed: ${env.subdir} ${bClientTipAtSeed}"`,
      env.localRepo,
    );
    git("push origin client-x", env.localRepo);

    // ── phase 3: post-seed commits on each b branch ──
    git("checkout main", env.remoteWorking);
    commitOnRemote(env, { "main-new.ts": "main-new content\n" }, "post-seed: main");

    git("checkout client-x", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "client-new.ts"), "client-new content\n");
    git("add client-new.ts", env.remoteWorking);
    git('commit -m "post-seed: client-x"', env.remoteWorking);
    git("push origin client-x", env.remoteWorking);

    // ── phase 4: sync both branches ──
    git("checkout main", env.localRepo);
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[sync 1] should succeed");
    assertIncludes(r1.stdout, "2 seed baseline", "[sync 1] should detect both seeds");

    git("fetch origin", env.localRepo);
    assertEqual(
      git("branch -r", env.localRepo).includes(`origin/shadow/${env.subdir}/main`),
      true, "[phase 4] shadow main branch exists",
    );
    assertEqual(
      git("branch -r", env.localRepo).includes(`origin/shadow/${env.subdir}/client-x`),
      true, "[phase 4] shadow client-x branch exists",
    );

    // Each shadow branch should have its own seed as a reachable ancestor
    // (proves seeds didn't collide or one didn't clobber the other).
    const mainShadowTip = git(`rev-parse origin/shadow/${env.subdir}/main`, env.localRepo);
    const clientShadowTip = git(`rev-parse origin/shadow/${env.subdir}/client-x`, env.localRepo);
    const mergeBaseMain = git(`merge-base origin/main ${mainShadowTip}`, env.localRepo);
    const mergeBaseClient = git(`merge-base origin/client-x ${clientShadowTip}`, env.localRepo);
    // Both merge-bases must exist (non-empty) — unrelated-histories would produce empty output.
    assertEqual(mergeBaseMain.length > 0, true, "[phase 4] main shadow has merge base with a/main");
    assertEqual(mergeBaseClient.length > 0, true, "[phase 4] client-x shadow has merge base with a/client-x");

    // ── phase 5: merge each shadow into its a-side branch ──
    git("checkout main", env.localRepo);
    git(`merge --no-ff origin/shadow/${env.subdir}/main`, env.localRepo);
    assertEqual(readLocalFile(env, "main-new.ts"), "main-new content\n", "[phase 5] main-new.ts on a/main");

    git("checkout client-x", env.localRepo);
    git(`merge --no-ff origin/shadow/${env.subdir}/client-x`, env.localRepo);
    assertEqual(readLocalFile(env, "client-new.ts"), "client-new content\n", "[phase 5] client-new.ts on a/client-x");
    assertEqual(readLocalFile(env, "a-only.ts"), "// a-side only\n", "[phase 5] a-only.ts preserved on a/client-x");
    // Pre-seed b-only content (client.ts) is correctly NOT replayed — the seed's
    // job is to skip history before it. client.ts reaches a only later via the
    // cross-branch merge in phase 7, when b/client-x merges into b/main.
    assertEqual(readLocalFile(env, "client.ts"), null, "[phase 5] pre-seed b-only client.ts absent on a/client-x");

    git("push origin client-x", env.localRepo);
    git("checkout main", env.localRepo);
    git("push origin main", env.localRepo);

    // ── phase 6: cross-branch merge on b (client-x → main) ──
    git("checkout main", env.remoteWorking);
    git("merge --no-ff client-x -m \"merge client-x into main\"", env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── phase 7: sync and pull cross-branch merge into a/main ──
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[sync 2] should succeed");

    git("fetch origin", env.localRepo);
    git("checkout main", env.localRepo);
    git(`merge --no-ff origin/shadow/${env.subdir}/main`, env.localRepo);

    // a/main should now have client-x's content (including the pre-seed
    // client.ts, which was b-only before — cross-branch merge brings it in).
    assertEqual(readLocalFile(env, "client-new.ts"), "client-new content\n", "[phase 7] client-new on a/main after cross-branch merge");
    assertEqual(readLocalFile(env, "client.ts"), "// client code\n", "[phase 7] pre-seed client.ts reached a/main via cross-branch merge");
    // a-only.ts only existed on a/client-x — cross-branch merge on b can't
    // pull it to a/main. That's fine; it's still on a/client-x.
    git("push origin main", env.localRepo);

    // ── phase 8: add 4 more pre-seed branches (f1..f4) on b with b-only content ──
    const features = ["f1", "f2", "f3", "f4"];
    const bTips: Record<string, string> = {};
    for (const f of features) {
      git(`checkout -b ${f} main`, env.remoteWorking);
      fs.writeFileSync(path.join(env.remoteWorking, `${f}-b.ts`), `// b-only pre-seed for ${f}\n`);
      git(`add ${f}-b.ts`, env.remoteWorking);
      git(`commit -m "pre-seed ${f} on b"`, env.remoteWorking);
      git(`push origin ${f}`, env.remoteWorking);
      bTips[f] = git(`rev-parse ${f}`, env.remoteWorking);
    }

    // ── phase 9: create f1..f4 on a off main, seed each ──
    git("fetch team", env.localRepo);
    for (const f of features) {
      git(`checkout -b ${f} main`, env.localRepo);
      git(
        `commit --allow-empty -m "Seed shadow-sync for ${env.subdir}/ from team/${f}" ` +
        `-m "Shadow-seed: ${env.subdir} ${bTips[f]}"`,
        env.localRepo,
      );
      git(`push origin ${f}`, env.localRepo);
    }

    // ── phase 10: post-seed commits on each feature, scattered extras ──
    for (const f of features) {
      git(`checkout ${f}`, env.remoteWorking);
      commitOnRemote(env, { [`${f}-work.ts`]: `${f} work content\n` }, `post-seed: ${f} work`);
      if (f === "f2" || f === "f3") {
        commitOnRemote(env, { [`${f}-extra.ts`]: `${f} extra content\n` }, `post-seed: ${f} extra commit`);
      }
      git(`push origin ${f}`, env.remoteWorking);
    }
    git("checkout main", env.remoteWorking);

    // ── phase 11: --from b populates all 4 shadow branches on a ──
    git("checkout main", env.localRepo);
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[phase 11] sync with 4 new branches should succeed");
    // 6 seeds total now: main + client-x + f1..f4
    assertIncludes(r3.stdout, "6 seed baseline", "[phase 11] detects all 6 seeds");

    git("fetch origin", env.localRepo);
    for (const f of features) {
      assertEqual(
        git("branch -r", env.localRepo).includes(`origin/shadow/${env.subdir}/${f}`),
        true,
        `[phase 11] shadow/${f} exists on a`,
      );
    }

    // ── phase 12: on a, merge shadows into features, cross-branch merge f1+f2 → a/main ──
    for (const f of features) {
      git(`checkout ${f}`, env.localRepo);
      git(`merge --no-ff origin/shadow/${env.subdir}/${f}`, env.localRepo);
      git(`push origin ${f}`, env.localRepo);
    }
    git("checkout main", env.localRepo);
    git(`merge --no-ff f1 -m "A: merge f1 into main"`, env.localRepo);
    git(`merge --no-ff f2 -m "A: merge f2 into main"`, env.localRepo);
    git("push origin main", env.localRepo);

    assertEqual(readLocalFile(env, "f1-work.ts"), "f1 work content\n", "[phase 12] a/main has f1-work.ts");
    assertEqual(readLocalFile(env, "f2-work.ts"), "f2 work content\n", "[phase 12] a/main has f2-work.ts");
    assertEqual(readLocalFile(env, "f2-extra.ts"), "f2 extra content\n", "[phase 12] a/main has f2-extra.ts");
    assertEqual(readLocalFile(env, "f3-work.ts"), null, "[phase 12] a/main does NOT have f3 yet");
    assertEqual(readLocalFile(env, "f4-work.ts"), null, "[phase 12] a/main does NOT have f4 yet");

    // ── phase 13: on b, cross-branch merge f3+f4 → b/main ──
    git("checkout main", env.remoteWorking);
    git(`merge --no-ff f3 -m "B: merge f3 into main"`, env.remoteWorking);
    git(`merge --no-ff f4 -m "B: merge f4 into main"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── phase 14: round-trip — push a's merges, pull b's merges ──
    const r4 = runPush(env);
    assertEqual(r4.status, 0, "[phase 14] --from a should succeed");
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[phase 14] --from b should succeed");

    // ── phase 15: integrate on both sides via shadow/main merge ──
    git("fetch origin", env.localRepo);
    git("checkout main", env.localRepo);
    git(`merge --no-ff origin/shadow/${env.subdir}/main -m "A: absorb b/main"`, env.localRepo);

    git("fetch origin", env.remoteWorking);
    git("checkout main", env.remoteWorking);
    git(`merge --no-ff origin/shadow/${env.subdir}/main -m "B: absorb a/main"`, env.remoteWorking);

    // ── phase 16: verify — all 4 features' post-seed content on both mains ──
    for (const f of features) {
      assertEqual(
        readLocalFile(env, `${f}-work.ts`),
        `${f} work content\n`,
        `[phase 16] a/main has ${f}-work.ts`,
      );
      const bPath = path.join(env.remoteWorking, `${f}-work.ts`);
      assertEqual(fs.existsSync(bPath), true, `[phase 16] b/main has ${f}-work.ts`);
    }
    assertEqual(readLocalFile(env, "f2-extra.ts"), "f2 extra content\n", "[phase 16] a/main has f2-extra.ts");
    assertEqual(readLocalFile(env, "f3-extra.ts"), "f3 extra content\n", "[phase 16] a/main has f3-extra.ts");
    assertEqual(fs.existsSync(path.join(env.remoteWorking, "f2-extra.ts")), true, "[phase 16] b/main has f2-extra.ts");
    assertEqual(fs.existsSync(path.join(env.remoteWorking, "f3-extra.ts")), true, "[phase 16] b/main has f3-extra.ts");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-multi-branch-seed");
}
