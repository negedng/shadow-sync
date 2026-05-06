import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnLocal, commitOnRemote, runPush, runCiSync, mergeShadow,
  readShadowFile, readExternalShadowFile, readLocalFile, readRemoteFile,
} from "./harness";
import { assertEqual, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Squash-merge scenarios.
 *
 * Same-side squash (collapsing a feature branch into a single commit on
 * THAT side's main, before any sync) is just a linear commit from the
 * engine's POV — should sync cleanly in either direction.
 *
 * Cross-repo squash — a consumer using `git merge --squash` on a shadow
 * ref to fold shadow content into a non-merge commit on their main,
 * possibly alongside native work — is the case the design doc flags as
 * out-of-scope (shadow-sync-design.html, M4 × M1 risk card).
 *
 * Phase A — Mira squash-merges a local feature branch into main, then push.
 * Phase B — Bea  squash-merges a remote feature branch into main, then sync.
 * Phase C — Bea  squash-merges shadow into her main alongside a native
 *           commit. Documents the current cross-repo behaviour.
 * Phase D — Mira pulls shadow INTO a feature branch, then squashes the
 *           feature into main. The shadow merge edge is buried inside
 *           feature and gets stripped by the squash — same breakage as C
 *           with one extra layer of indirection.
 */

function phaseA_localSquashBeforePush(): void {
  const env = createTestEnv("squash-A-local-side");
  try {
    commitOnLocal(env, { "app.ts": "v1\n" }, "Mira: bootstrap");
    const r0 = runPush(env);
    assertEqual(r0.status, 0, "[A] bootstrap push should succeed");

    git("checkout -b feature-a", env.localRepo);
    commitOnLocal(env, { "feat-a-1.ts": "step 1\n" }, "Mira: a step 1");
    commitOnLocal(env, { "feat-a-2.ts": "step 2\n" }, "Mira: a step 2");
    commitOnLocal(env, { "feat-a-1.ts": "step 1 v2\n" }, "Mira: a step 1 fixup");
    git("checkout main", env.localRepo);

    git("merge --squash feature-a", env.localRepo);
    git('commit -m "Mira: squash-merge feature-a"', env.localRepo);
    git("branch -D feature-a", env.localRepo);

    const r = runPush(env);
    assertEqual(r.status, 0, "[A] push of squash commit should succeed");
    assertNotIncludes(r.stdout + r.stderr, "diverged with different tree", "[A] no different-tree halt");

    assertEqual(readExternalShadowFile(env, "feat-a-1.ts"), "step 1 v2\n", "[A] squashed file 1 on shadow");
    assertEqual(readExternalShadowFile(env, "feat-a-2.ts"), "step 2\n",    "[A] squashed file 2 on shadow");

    // Round-trip: Bea pulls shadow with a normal (non-squash) merge — the
    // squash commit becomes part of the shadow chain like any other linear
    // commit, so a plain `git merge` works.
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --no-ff origin/${shadowBranch} -m "Bea: merge shadow"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    assertEqual(readRemoteFile(env, "feat-a-1.ts"), "step 1 v2\n", "[A] Mira's squash reached Bea's main");
    assertEqual(readRemoteFile(env, "feat-a-2.ts"), "step 2\n",    "[A] Mira's squash reached Bea's main (file 2)");

    // Bea adds work, ci-sync round-trips it back.
    commitOnRemote(env, { "bea-after.txt": "after\n" }, "Bea: after");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[A] ci-sync after squash round-trip should succeed");
    assertNotIncludes(r2.stdout + r2.stderr, "diverged with different tree", "[A] no different-tree halt on round-trip");
  } finally {
    env.cleanup();
  }
}

function phaseB_remoteSquashBeforeSync(): void {
  const env = createTestEnv("squash-B-remote-side");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: bootstrap");
    const r0 = runCiSync(env);
    assertEqual(r0.status, 0, "[B] bootstrap ci-sync should succeed");

    git("checkout -b feature-b", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat-b-1.txt"), "b1\n");
    fs.writeFileSync(path.join(env.remoteWorking, "feat-b-2.txt"), "b2\n");
    git("add feat-b-1.txt feat-b-2.txt", env.remoteWorking);
    git('commit -m "Bea: b1 + b2"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat-b-1.txt"), "b1 v2\n");
    git("add feat-b-1.txt", env.remoteWorking);
    git('commit -m "Bea: b1 fixup"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat-b-3.txt"), "b3\n");
    git("add feat-b-3.txt", env.remoteWorking);
    git('commit -m "Bea: b3"', env.remoteWorking);

    git("checkout main", env.remoteWorking);
    git("merge --squash feature-b", env.remoteWorking);
    git('commit -m "Bea: squash-merge feature-b"', env.remoteWorking);
    git("branch -D feature-b", env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[B] ci-sync of squash commit should succeed");
    assertNotIncludes(r.stdout + r.stderr, "diverged with different tree", "[B] no different-tree halt");

    assertEqual(readShadowFile(env, "feat-b-1.txt"), "b1 v2\n", "[B] squashed file 1 on shadow");
    assertEqual(readShadowFile(env, "feat-b-2.txt"), "b2\n",    "[B] squashed file 2 on shadow");
    assertEqual(readShadowFile(env, "feat-b-3.txt"), "b3\n",    "[B] squashed file 3 on shadow");

    // Round-trip: Mira merges shadow normally — Bea's squash commit replays
    // into her main without drama.
    mergeShadow(env);
    assertEqual(readLocalFile(env, "feat-b-1.txt"), "b1 v2\n", "[B] Bea's squash reached Mira's main");
    assertEqual(readLocalFile(env, "feat-b-2.txt"), "b2\n",    "[B] Bea's squash reached Mira's main (file 2)");

    commitOnLocal(env, { "mira-after.ts": "after\n" }, "Mira: after");
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[B] push after squash round-trip should succeed");
    assertNotIncludes(r2.stdout + r2.stderr, "diverged with different tree", "[B] no different-tree halt on round-trip");
  } finally {
    env.cleanup();
  }
}

function phaseC_crossRepoSquashIsBroken(): void {
  // The documented unsupported case (shadow-sync-design.html M4 × M1):
  // Bea uses `git merge --squash` against the shadow ref, folding Mira's
  // shadow content AND a native commit into a single non-merge commit on
  // her main. The squash strips the merge parent that would have linked
  // back to the previously-replayed shadow chain — so when ci-sync runs,
  // the engine treats Bea's main as un-replayed b-side history and re-
  // replays Mira's content from scratch. This phase asserts the breakage
  // is observable downstream (so a future fix flips the assertion).
  const env = createTestEnv("squash-C-cross-repo");
  try {
    // Mira pushes work to shadow.
    commitOnLocal(env, { "shared.ts": "from mira\n" }, "Mira: shared");
    commitOnLocal(env, { "shared2.ts": "more mira\n" }, "Mira: shared2");
    const rPush = runPush(env);
    assertEqual(rPush.status, 0, "[C] push should succeed");
    const miraShadowBefore = git(`rev-parse team/${env.branchPrefix}/${env.subdir}/main`, env.localRepo);

    // Bea makes a native commit on her main BEFORE folding shadow.
    commitOnRemote(env, { "bea-native.txt": "bea native\n" }, "Bea: native");

    // Bea squash-merges shadow into main — combines Mira's content with her
    // native commit into a single non-merge commit.
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --squash origin/${shadowBranch}`, env.remoteWorking);
    git('commit -m "Bea: squash shadow into main (cross-repo)"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ci-sync runs without halting (it doesn't see this as a divergence)…
    const r = runCiSync(env);
    assertEqual(r.status, 0, "[C] ci-sync exits 0 — engine doesn't detect the lost link");

    // …but the breakage is visible in the replay log: the engine found 0
    // previously-replayed commits and re-replayed the b-side history from
    // the very root. Mira's commits are now duplicated on origin/shadow
    // under new SHAs, no longer connected to her original push chain.
    assertEqual(
      r.stdout.includes("Found 0 previously replayed commit(s)"), true,
      "[C] engine fails to recognise the prior replay chain — root cause of the breakage",
    );

    // Concretely: the origin shadow tip after ci-sync is NOT a descendant
    // of Mira's previous shadow tip. A normal mergeShadow back into Mira's
    // main would produce a 3-way merge that duplicates her own content.
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const originShadowTip = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    let isAncestor = false;
    try {
      execSync(`git merge-base --is-ancestor ${miraShadowBefore} ${originShadowTip}`,
        { cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"] });
      isAncestor = true;
    } catch { isAncestor = false; }
    assertEqual(
      isAncestor, false,
      "[C] origin/shadow tip is NOT a descendant of Mira's prior shadow tip — chain forked",
    );
  } finally {
    env.cleanup();
  }
}

function phaseD_shadowAbsorbedByFeatureThenSquashed(): void {
  // Realistic workflow:
  //   1. Mira's main is shadow-aware (prior mergeShadow).
  //   2. Mira branches feature off main, makes commits.
  //   3. Bea pushes new content; shadow chain advances.
  //   4. Mira pulls shadow INTO her feature branch (not into main) so she
  //      can finish work against the latest.
  //   5. Mira ships feature with `git merge --squash feature && commit`
  //      on main.
  //
  // The squash on main strips feature's parent linkage, including the
  // shadow merge edge that was buried inside feature. Same forked-chain
  // breakage as Phase C, just one level of indirection deeper.
  const env = createTestEnv("squash-D-feature-absorbs-shadow");
  try {
    // Bootstrap a shadow chain via Bea (b-side).
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: base");
    const r0 = runCiSync(env);
    assertEqual(r0.status, 0, "[D] bootstrap ci-sync should succeed");

    // Mira pulls shadow into main so main is shadow-aware before branching.
    mergeShadow(env);

    // Mira creates feature off main and adds work.
    git("checkout -b feature-d", env.localRepo);
    commitOnLocal(env, { "feat-d-1.ts": "step 1\n" }, "Mira: feat-d step 1");
    commitOnLocal(env, { "feat-d-2.ts": "step 2\n" }, "Mira: feat-d step 2");

    // Bea pushes new content while Mira works; ci-sync advances shadow.
    commitOnRemote(env, { "bea-during.txt": "bea during\n" }, "Bea: during feature");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[D] mid-feature ci-sync should succeed");

    // Snapshot the shadow tip BEFORE the squash. After ci-sync, origin's
    // shadow ref is the canonical reference; team's ref isn't populated
    // until a runPush has happened.
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTipBefore = git(`rev-parse origin/${shadowBranch}`, env.localRepo);

    // Mira pulls the latest shadow INTO her feature branch (not main).
    git(`merge --no-ff origin/${shadowBranch} -m "Mira: pull shadow into feature"`, env.localRepo);

    // Mira squash-merges feature into main. The shadow edge buried in
    // feature is stripped by the squash.
    git("checkout main", env.localRepo);
    git("merge --squash feature-d", env.localRepo);
    git('commit -m "Mira: squash feature-d into main"', env.localRepo);
    git("branch -D feature-d", env.localRepo);

    // Push exits 0 but the chain forks: the squash commit's only parent on
    // main is Mira's pre-squash main tip, which on the shadow side maps to
    // an ancestor of `shadowTipBefore` (the merge-shadow point). The new
    // shadow commit is replayed onto that older ancestor, so the post-push
    // tip is a sibling of `shadowTipBefore`, not a descendant.
    const r = runPush(env);
    assertEqual(r.status, 0, "[D] push exits 0 — engine doesn't detect the lost link");

    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const teamShadowAfter = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);

    let isAncestor = false;
    try {
      execSync(
        `git merge-base --is-ancestor ${shadowTipBefore} ${teamShadowAfter}`,
        { cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"] },
      );
      isAncestor = true;
    } catch { isAncestor = false; }
    assertEqual(
      isAncestor, false,
      "[D] team/shadow tip is NOT a descendant of prior shadow tip — chain forked",
    );
  } finally {
    env.cleanup();
  }
}

export default function run() {
  phaseA_localSquashBeforePush();
  phaseB_remoteSquashBeforeSync();
  phaseC_crossRepoSquashIsBroken();
  phaseD_shadowAbsorbedByFeatureThenSquashed();
}

if (require.main === module) {
  run();
  console.log("PASS  test-squash-merges");
}
