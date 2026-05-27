/**
 * Consolidated merge-handling test. Six sub-tests:
 *
 *   A. merge-topology — shared SHAs across branches, evil merges, octopus
 *      (formerly test-pull-merge-topology.ts)
 *   B. echo-mapping — echo commits resolve to original SHAs, not fallback tip
 *      (formerly test-pull-echo-mapping.ts)
 *   C. echo-intermediate-outer — M1 cross-repo merge composition
 *      (formerly test-pull-echo-intermediate-outer.ts)
 *   D. push-merge-skipped-parents — merges whose parents drop out via path filter
 *      (formerly test-push-merge-skipped-parents.ts)
 *   E. squash-merges — local + cross-repo squashes
 *      (formerly test-squash-merges.ts)
 *   F. manual-merge-recovery — outer-divergence hard fail + operator-driven
 *      reconciliation via Shadow-replayed-* trailer
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnLocal, commitOnRemote,
  runCiSync, mergeShadow, runPush,
  readShadowFile, readExternalShadowFile, readLocalFile, readRemoteFile,
  getExternalShadowLogFull,
  setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string, opts?: { env?: NodeJS.ProcessEnv; input?: string }): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: opts?.env,
    input: opts?.input,
  }).trim();
}

function extractLocalSHA(log: string, messagePrefix: string): string {
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(messagePrefix)) {
      for (let j = i - 1; j >= 0; j--) {
        if (/^[0-9a-f]{40}$/.test(lines[j])) return lines[j];
      }
    }
  }
  throw new Error(`Could not find commit with message prefix "${messagePrefix}" in log`);
}

// ── A. merge-topology: shared SHAs, evil merges, octopus merges ────────────
function runMergeTopology(): void {
  const env = createTestEnv("pull-merge-topology");
  try {
    // phase 1: shared-topology
    fs.writeFileSync(path.join(env.remoteWorking, "main.ts"), "main v1\n");
    git("add main.ts", env.remoteWorking);
    git('commit -m "B: add main.ts"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    git("checkout -b feature/merge-test", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat.ts"), "feat v1\n");
    git("add feat.ts", env.remoteWorking);
    git('commit -m "C: add feat.ts"', env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "feat.ts"), "feat v2\n");
    git("add feat.ts", env.remoteWorking);
    git('commit -m "D: update feat.ts"', env.remoteWorking);
    git("push origin feature/merge-test", env.remoteWorking);

    git("checkout main", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "main.ts"), "main v2\n");
    git("add main.ts", env.remoteWorking);
    git('commit -m "E: update main.ts"', env.remoteWorking);
    git('merge feature/merge-test --no-ff -m "F: merge feature into main"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[topology 1: shared] ci-sync should succeed");

    git("fetch origin", env.localRepo);
    const mainShadow = "origin/shadow/frontend/main";
    const featShadow = "origin/shadow/frontend/feature/merge-test";

    assertEqual(git(`show ${mainShadow}:frontend/main.ts`, env.localRepo), "main v2", "[topology 1] main.ts v2 on main shadow");
    assertEqual(git(`show ${mainShadow}:frontend/feat.ts`, env.localRepo), "feat v2", "[topology 1] feat.ts on main shadow (merged)");
    assertEqual(git(`show ${featShadow}:frontend/feat.ts`, env.localRepo), "feat v2", "[topology 1] feat.ts v2 on feature shadow");
    assertEqual(git(`show ${featShadow}:frontend/main.ts`, env.localRepo), "main v1", "[topology 1] main.ts v1 on feature shadow");

    const mainLog = git(`log --format=%H%n%B ${mainShadow} -- frontend/`, env.localRepo);
    const featLog = git(`log --format=%H%n%B ${featShadow} -- frontend/`, env.localRepo);
    const bOnMain = extractLocalSHA(mainLog, "B: add main.ts");
    const bOnFeat = extractLocalSHA(featLog, "B: add main.ts");
    assertEqual(bOnMain, bOnFeat, "[topology 1] B has shared SHA on both shadow branches");
    const cOnMain = extractLocalSHA(mainLog, "C: add feat.ts");
    const cOnFeat = extractLocalSHA(featLog, "C: add feat.ts");
    assertEqual(cOnMain, cOnFeat, "[topology 1] C has shared SHA on both shadow branches");

    const fSHA = extractLocalSHA(mainLog, "F: merge feature into main");
    const fParents = git(`rev-list --parents -1 ${fSHA}`, env.localRepo).split(/\s+/).length - 1;
    assertEqual(fParents, 2, "[topology 1] F is a 2-parent merge commit");

    // phase 2: evil-merge
    fs.writeFileSync(path.join(env.remoteWorking, "evil2.ts"), "evil2 v1\n");
    git("add evil2.ts", env.remoteWorking);
    git('commit -m "evil2 v1 on main"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    git("checkout -b evil-feat", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "evil-feat.ts"), "ef\n");
    git("add evil-feat.ts", env.remoteWorking);
    git('commit -m "Add evil-feat.ts"', env.remoteWorking);
    git("push origin evil-feat", env.remoteWorking);

    git("checkout main", env.remoteWorking);
    git("merge --no-ff --no-commit evil-feat", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "evil2.ts"), "evil2 EVIL\n");
    git("add evil2.ts", env.remoteWorking);
    git('commit -m "Evil merge: merged evil-feat and tweaked evil2"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[topology 2: evil-merge] ci-sync should succeed");
    assertEqual(readShadowFile(env, "evil-feat.ts"), "ef\n", "[topology 2] evil-feat.ts on main shadow");
    assertEqual(readShadowFile(env, "evil2.ts"), "evil2 EVIL\n", "[topology 2] evil edit preserved on shadow");

    git("fetch origin shadow/frontend/main", env.localRepo);
    const evilParents = git("log -1 --format=%P origin/shadow/frontend/main", env.localRepo)
      .split(/\s+/).filter(Boolean).length;
    assertEqual(evilParents, 2, "[topology 2] evil merge tip is 2-parent");

    // phase 3: octopus-merge
    const baseSha = git("rev-parse HEAD", env.remoteWorking);
    for (const f of ["oct-f1", "oct-f2", "oct-f3"]) {
      git(`checkout -b ${f} ${baseSha}`, env.remoteWorking);
      fs.writeFileSync(path.join(env.remoteWorking, `${f}.ts`), `${f}\n`);
      git(`add ${f}.ts`, env.remoteWorking);
      git(`commit -m "Add ${f}"`, env.remoteWorking);
      git(`push origin ${f}`, env.remoteWorking);
    }
    git("checkout main", env.remoteWorking);
    git('merge --no-ff oct-f1 oct-f2 oct-f3 -m "Octopus merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[topology 3: octopus] ci-sync should succeed");
    assertEqual(readShadowFile(env, "oct-f1.ts"), "oct-f1\n", "[topology 3] oct-f1.ts on shadow");
    assertEqual(readShadowFile(env, "oct-f2.ts"), "oct-f2\n", "[topology 3] oct-f2.ts on shadow");
    assertEqual(readShadowFile(env, "oct-f3.ts"), "oct-f3\n", "[topology 3] oct-f3.ts on shadow");
    git("fetch origin shadow/frontend/main", env.localRepo);
    const octParents = git("log -1 --format=%P origin/shadow/frontend/main", env.localRepo)
      .split(/\s+/).filter(Boolean).length;
    assertEqual(octParents, 4, "[topology 3] shadow main tip is 4-parent octopus merge");
  } finally {
    env.cleanup();
  }
}

// ── B. echo-mapping: echo commits resolve to original SHAs ─────────────────
function runEchoMapping(): void {
  const env = createTestEnv("pull-echo-mapping");
  try {
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;

    // Phase 1: no-ff merge with B-side commit before it
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[echo-map 1] initial pull should succeed");
    mergeShadow(env);

    commitOnLocal(env, { "from-a.ts": "A's work\n" }, "b: add from-a.ts");
    const hashB = git("rev-parse HEAD", env.localRepo);

    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[echo-map 1] push A→B should succeed");

    fs.writeFileSync(path.join(env.remoteWorking, "b-pre.ts"), "B before merge\n");
    git("add b-pre.ts", env.remoteWorking);
    git('commit -m "a: B commit before merge"', env.remoteWorking);

    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge origin/${shadowBranch} --no-ff -m "merge shadow into B main"`, env.remoteWorking);

    fs.writeFileSync(path.join(env.remoteWorking, "b-post.ts"), "B after merge\n");
    git("add b-post.ts", env.remoteWorking);
    git('commit -m "c: B commit after merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    commitOnLocal(env, { "a-after.ts": "A keeps going\n" }, "A: post-b work");
    const hashAfterB = git("rev-parse HEAD", env.localRepo);

    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[echo-map 1] pull B→A should succeed");

    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTip1 = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    const ancestors1 = git(`rev-list ${shadowTip1}`, env.localRepo).split("\n");
    assertIncludes(ancestors1.join("\n"), hashB,
      "[echo-map 1] original `b` hash must appear in shadow branch ancestry");
    assertEqual(ancestors1.includes(hashAfterB), false,
      "[echo-map 1] post-b tip must NOT appear in shadow ancestry");

    // Phase 2: FF merge with no extra B commits
    mergeShadow(env);

    commitOnLocal(env, { "phase2.ts": "A phase-2 work\n" }, "c: phase 2 A commit");
    const hashC = git("rev-parse HEAD", env.localRepo);

    const r4 = runPush(env);
    assertEqual(r4.status, 0, "[echo-map 2] push A→B should succeed");

    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --ff-only origin/${shadowBranch}`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[echo-map 2] pull B→A should succeed");

    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTip2 = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    assertEqual(shadowTip2, hashC,
      "[echo-map 2] shadow branch tip should be A's original `c` (echo mapped to original)");
  } finally {
    env.cleanup();
  }
}

// ── C. echo-intermediate-outer: M1 cross-repo merge composition ────────────
function runEchoIntermediateOuter(): void {
  const env = createTestEnv("pull-echo-intermediate-outer");
  try {
    runCiSync(env);
    mergeShadow(env);

    fs.writeFileSync(path.join(env.localRepo, env.subdir, "feature.ts"), "feature from A\n");
    git(`add ${env.subdir}/feature.ts`, env.localRepo);
    fs.writeFileSync(path.join(env.localRepo, "mono.txt"), "monorepo updated by x\n");
    git("add mono.txt", env.localRepo);
    git('commit -m "x: A modifies frontend AND outer mono.txt"', env.localRepo);
    const xHash = git("rev-parse HEAD", env.localRepo);
    git("push origin main", env.localRepo);

    const r1 = runPush(env);
    assertEqual(r1.status, 0, "[m1] push should succeed");

    git(`fetch origin shadow/${env.subdir}/main`, env.remoteWorking);
    git(`merge --no-ff origin/shadow/${env.subdir}/main -m "B: merge shadow into main"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    fs.writeFileSync(path.join(env.remoteWorking, "after-merge.ts"), "B's work after merge\n");
    git("add after-merge.ts", env.remoteWorking);
    git('commit -m "a: B commit after merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[m1] pull should succeed");

    git("fetch origin", env.localRepo);
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    const tipSha = git(`rev-parse origin/${shadowBranch}`, env.localRepo);

    const mergesOutput = git(`log --merges --format=%H origin/${shadowBranch}`, env.localRepo);
    const mergeCandidates = mergesOutput.split("\n").filter(Boolean);

    let mergeReplayed: string | null = null;
    for (const candidate of mergeCandidates) {
      const parents = git(`log -1 --format=%P ${candidate}`, env.localRepo).split(/\s+/).filter(Boolean);
      if (parents.includes(xHash)) {
        mergeReplayed = candidate;
        break;
      }
    }
    assertEqual(mergeReplayed != null, true,
      `[m1] should find replayed merge with x as parent. Candidates: ${mergeCandidates.join(", ")}`);

    const mergeParents = git(`log -1 --format=%P ${mergeReplayed}`, env.localRepo).split(/\s+/).filter(Boolean);
    assertEqual(mergeParents.length, 2, `[m1] merge replay should have 2 parents, got ${mergeParents.length}`);
    assertEqual(mergeParents.includes(xHash), true, `[m1] merge replay should have x as a parent via echo`);

    const monoOnMerge = git(`show ${mergeReplayed}:mono.txt`, env.localRepo);
    assertEqual(monoOnMerge.trim(), "monorepo updated by x",
      "[m1] merge-replay's mono.txt should have x's modification (M1 composed x's outer)");

    const monoOnTip = git(`show ${tipSha}:mono.txt`, env.localRepo);
    assertEqual(monoOnTip.trim(), "monorepo updated by x",
      "[m1] tip's mono.txt should have x's modification");

    const featureOnMerge = git(`show ${mergeReplayed}:${env.subdir}/feature.ts`, env.localRepo);
    assertEqual(featureOnMerge.trim(), "feature from A",
      "[m1] merge-replay's frontend/feature.ts should have x's contribution");

    let readmePresent = false;
    try {
      git(`show ${mergeReplayed}:${env.subdir}/README.md`, env.localRepo);
      readmePresent = true;
    } catch { /* not found */ }
    assertEqual(readmePresent, true,
      "[m1] merge-replay should still have frontend/README.md from earlier B-side commit");
  } finally {
    env.cleanup();
  }
}

// ── D. push-merge-skipped-parents: merges whose parents drop out of rev-list ─
function runPushMergeSkippedParents(): void {
  const env = createTestEnv("push-merge-skipped-parents");
  try {
    commitOnLocal(env, { "app.ts": "v1\n" }, "M1: bootstrap app.ts");
    const r0 = runPush(env);
    assertEqual(r0.status, 0, "[skipped-parents M1] bootstrap push should succeed");
    const m1 = git("rev-parse HEAD", env.localRepo);

    git("checkout -b feature1", env.localRepo);
    commitOnLocal(env, { "feat1.ts": "feat1\n" }, "M2: feat1.ts on feature1");
    const m2 = git("rev-parse HEAD", env.localRepo);

    fs.writeFileSync(path.join(env.localRepo, "ai-notes-1.txt"), "ai work for feat1\n");
    git("add ai-notes-1.txt", env.localRepo);
    git('commit -m "M4: AI-only edits outside subdir (feature1)"', env.localRepo);
    const m4 = git("rev-parse HEAD", env.localRepo);

    git(`checkout -b feature2 ${m1}`, env.localRepo);
    commitOnLocal(env, { "feat2.ts": "feat2\n" }, "M3: feat2.ts on feature2");
    const m3 = git("rev-parse HEAD", env.localRepo);

    fs.writeFileSync(path.join(env.localRepo, "ai-notes-2.txt"), "ai work for feat2\n");
    git("add ai-notes-2.txt", env.localRepo);
    git('commit -m "M5: AI-only edits outside subdir (feature2)"', env.localRepo);
    const m5 = git("rev-parse HEAD", env.localRepo);

    git("checkout feature1", env.localRepo);
    git('merge --no-ff feature2 -m "M6: merge feature2 into feature1"', env.localRepo);
    const m6 = git("rev-parse HEAD", env.localRepo);
    const m6Parents = git("rev-list --parents -1 HEAD", env.localRepo).split(/\s+/).slice(1);
    assertEqual(m6Parents.length, 2, "[skipped-parents setup] M6 should have 2 parents");
    assertEqual(m6Parents[0], m4, "[skipped-parents setup] M6 first parent is M4");
    assertEqual(m6Parents[1], m5, "[skipped-parents setup] M6 second parent is M5");

    git("checkout main", env.localRepo);
    git(`merge --ff-only ${m6}`, env.localRepo);
    git("branch -D feature1", env.localRepo);
    git("branch -D feature2", env.localRepo);

    const rPush = runPush(env);
    assertEqual(rPush.status, 0, "[skipped-parents push] should succeed");

    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const shadowTip = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);
    const shadowTipParents = git(`rev-list --parents -1 ${shadowTip}`, env.localRepo).split(/\s+/).slice(1);

    assertEqual(shadowTipParents.length, 2, `[skipped-parents shadow] M6' has 2 parents (got ${shadowTipParents.length})`);

    const trailerKey = `Shadow-replayed-${env.subdir}-origin`;
    const shadowLogFull = getExternalShadowLogFull(env, 50);
    const mapping = new Map<string, string>();
    {
      const blocks = git(
        `log ${env.remoteName}/${shadowBranch} --format=%H%x00%(trailers:only,unfold=true)%x01`,
        env.localRepo,
      ).split("\x01").map(s => s.trim()).filter(Boolean);
      for (const b of blocks) {
        const [shadowSha, trailers] = b.split("\x00");
        const m = trailers?.match(new RegExp(`^${trailerKey}:\\s*([0-9a-f]+)`, "m"));
        if (m) mapping.set(m[1], shadowSha.trim());
      }
    }

    const m1Shadow = mapping.get(m1);
    const m2Shadow = mapping.get(m2);
    const m3Shadow = mapping.get(m3);
    const m6Shadow = mapping.get(m6);
    assertEqual(typeof m1Shadow, "string", "[skipped-parents shadow] M1 was replayed");
    assertEqual(typeof m2Shadow, "string", "[skipped-parents shadow] M2 was replayed");
    assertEqual(typeof m3Shadow, "string", "[skipped-parents shadow] M3 was replayed");
    assertEqual(typeof m6Shadow, "string", "[skipped-parents shadow] M6 was replayed");

    assertEqual(mapping.has(m4), false, "[skipped-parents shadow] M4 (AI-only) NOT replayed");
    assertEqual(mapping.has(m5), false, "[skipped-parents shadow] M5 (AI-only) NOT replayed");
    assertNotIncludes(shadowLogFull, m4, "[skipped-parents shadow] no commit references M4");
    assertNotIncludes(shadowLogFull, m5, "[skipped-parents shadow] no commit references M5");

    assertEqual(shadowTip, m6Shadow, "[skipped-parents shadow] tip is M6'");

    const expectedSet = new Set([m2Shadow!, m3Shadow!]);
    const actualSet = new Set(shadowTipParents);
    assertEqual(actualSet.size, 2, "[skipped-parents shadow] M6' parents are distinct");
    const allMatch = Array.from(actualSet).every(p => expectedSet.has(p));
    assertEqual(allMatch, true, `[skipped-parents shadow] M6' parents are M2' and M3'`);
  } finally {
    env.cleanup();
  }
}

// ── E. squash-merges: same-side and cross-repo squashes ─────────────────────
function runSquashLocalBeforePush(): void {
  const env = createTestEnv("squash-A-local-side");
  try {
    commitOnLocal(env, { "app.ts": "v1\n" }, "Mira: bootstrap");
    const r0 = runPush(env);
    assertEqual(r0.status, 0, "[squash A] bootstrap push should succeed");

    git("checkout -b feature-a", env.localRepo);
    commitOnLocal(env, { "feat-a-1.ts": "step 1\n" }, "Mira: a step 1");
    commitOnLocal(env, { "feat-a-2.ts": "step 2\n" }, "Mira: a step 2");
    commitOnLocal(env, { "feat-a-1.ts": "step 1 v2\n" }, "Mira: a step 1 fixup");
    git("checkout main", env.localRepo);

    git("merge --squash feature-a", env.localRepo);
    git('commit -m "Mira: squash-merge feature-a"', env.localRepo);
    git("branch -D feature-a", env.localRepo);

    const r = runPush(env);
    assertEqual(r.status, 0, "[squash A] push of squash commit should succeed");
    assertNotIncludes(r.stdout + r.stderr, "diverged with different tree", "[squash A] no different-tree halt");

    assertEqual(readExternalShadowFile(env, "feat-a-1.ts"), "step 1 v2\n", "[squash A] squashed file 1 on shadow");
    assertEqual(readExternalShadowFile(env, "feat-a-2.ts"), "step 2\n",    "[squash A] squashed file 2 on shadow");

    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --no-ff origin/${shadowBranch} -m "Bea: merge shadow"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    assertEqual(readRemoteFile(env, "feat-a-1.ts"), "step 1 v2\n", "[squash A] Mira's squash reached Bea's main");
    assertEqual(readRemoteFile(env, "feat-a-2.ts"), "step 2\n",    "[squash A] Mira's squash reached Bea's main (file 2)");

    commitOnRemote(env, { "bea-after.txt": "after\n" }, "Bea: after");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[squash A] ci-sync after squash round-trip should succeed");
    assertNotIncludes(r2.stdout + r2.stderr, "diverged with different tree", "[squash A] no different-tree halt on round-trip");
  } finally {
    env.cleanup();
  }
}

function runSquashRemoteBeforeSync(): void {
  const env = createTestEnv("squash-B-remote-side");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: bootstrap");
    const r0 = runCiSync(env);
    assertEqual(r0.status, 0, "[squash B] bootstrap ci-sync should succeed");

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
    assertEqual(r.status, 0, "[squash B] ci-sync of squash commit should succeed");
    assertNotIncludes(r.stdout + r.stderr, "diverged with different tree", "[squash B] no different-tree halt");

    assertEqual(readShadowFile(env, "feat-b-1.txt"), "b1 v2\n", "[squash B] squashed file 1 on shadow");
    assertEqual(readShadowFile(env, "feat-b-2.txt"), "b2\n",    "[squash B] squashed file 2 on shadow");
    assertEqual(readShadowFile(env, "feat-b-3.txt"), "b3\n",    "[squash B] squashed file 3 on shadow");

    mergeShadow(env);
    assertEqual(readLocalFile(env, "feat-b-1.txt"), "b1 v2\n", "[squash B] Bea's squash reached Mira's main");
    assertEqual(readLocalFile(env, "feat-b-2.txt"), "b2\n",    "[squash B] Bea's squash reached Mira's main (file 2)");

    commitOnLocal(env, { "mira-after.ts": "after\n" }, "Mira: after");
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[squash B] push after squash round-trip should succeed");
    assertNotIncludes(r2.stdout + r2.stderr, "diverged with different tree", "[squash B] no different-tree halt on round-trip");
  } finally {
    env.cleanup();
  }
}

function runSquashCrossRepoBroken(): void {
  const env = createTestEnv("squash-C-cross-repo");
  try {
    commitOnLocal(env, { "shared.ts": "from mira\n" }, "Mira: shared");
    commitOnLocal(env, { "shared2.ts": "more mira\n" }, "Mira: shared2");
    const rPush = runPush(env);
    assertEqual(rPush.status, 0, "[squash C] push should succeed");
    const miraShadowBefore = git(`rev-parse team/${env.branchPrefix}/${env.subdir}/main`, env.localRepo);

    commitOnRemote(env, { "bea-native.txt": "bea native\n" }, "Bea: native");

    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --squash origin/${shadowBranch}`, env.remoteWorking);
    git('commit -m "Bea: squash shadow into main (cross-repo)"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[squash C] ci-sync exits 0 — engine doesn't detect the lost link");
    assertEqual(r.stdout.includes("Found 0 previously replayed commit(s)"), true,
      "[squash C] engine fails to recognise the prior replay chain");

    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const originShadowTip = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    let isAncestor = false;
    try {
      execSync(`git merge-base --is-ancestor ${miraShadowBefore} ${originShadowTip}`,
        { cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"] });
      isAncestor = true;
    } catch { isAncestor = false; }
    assertEqual(isAncestor, false, "[squash C] origin/shadow tip is NOT a descendant of Mira's prior shadow tip");
  } finally {
    env.cleanup();
  }
}

function runSquashFeatureAbsorbsShadow(): void {
  const env = createTestEnv("squash-D-feature-absorbs-shadow");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: base");
    const r0 = runCiSync(env);
    assertEqual(r0.status, 0, "[squash D] bootstrap ci-sync should succeed");

    mergeShadow(env);

    git("checkout -b feature-d", env.localRepo);
    commitOnLocal(env, { "feat-d-1.ts": "step 1\n" }, "Mira: feat-d step 1");
    commitOnLocal(env, { "feat-d-2.ts": "step 2\n" }, "Mira: feat-d step 2");

    commitOnRemote(env, { "bea-during.txt": "bea during\n" }, "Bea: during feature");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[squash D] mid-feature ci-sync should succeed");

    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTipBefore = git(`rev-parse origin/${shadowBranch}`, env.localRepo);

    git(`merge --no-ff origin/${shadowBranch} -m "Mira: pull shadow into feature"`, env.localRepo);

    git("checkout main", env.localRepo);
    git("merge --squash feature-d", env.localRepo);
    git('commit -m "Mira: squash feature-d into main"', env.localRepo);
    git("branch -D feature-d", env.localRepo);

    const r = runPush(env);
    assertEqual(r.status, 0, "[squash D] push exits 0 — engine doesn't detect the lost link");

    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const teamShadowAfter = git(`rev-parse ${env.remoteName}/${shadowBranch}`, env.localRepo);

    let isAncestor = false;
    try {
      execSync(`git merge-base --is-ancestor ${shadowTipBefore} ${teamShadowAfter}`,
        { cwd: env.localRepo, stdio: ["pipe", "pipe", "pipe"] });
      isAncestor = true;
    } catch { isAncestor = false; }
    assertEqual(isAncestor, false, "[squash D] team/shadow tip is NOT a descendant of prior shadow tip");
  } finally {
    env.cleanup();
  }
}

// ── F. manual-merge-recovery: outer divergence forces hard fail + operator fix ─
function runManualMergeRecovery(): void {
  const env = createTestEnv("manual-merge-recovery");
  const local = env.localRepo;
  const team = env.remoteWorking;

  try {
    // ── Source layout: base on main; branch-a adds feat-a; branch-b adds feat-b.
    fs.writeFileSync(path.join(team, "base.ts"), "base\n");
    git("add base.ts", team);
    git('commit -m "Base"', team);
    git("push origin main", team);

    git("checkout -b branch-a", team);
    fs.writeFileSync(path.join(team, "feat-a.ts"), "a\n");
    git("add feat-a.ts", team);
    git('commit -m "feat A"', team);
    git("push origin branch-a", team);

    git("checkout main", team);
    git("checkout -b branch-b", team);
    fs.writeFileSync(path.join(team, "feat-b.ts"), "b\n");
    git("add feat-b.ts", team);
    git('commit -m "feat B"', team);
    git("push origin branch-b", team);

    // First sync fans out main + branch-a + branch-b into shadow refs on origin.
    assertEqual(runCiSync(env).status, 0, "[recovery] initial sync");

    // Rewrite shadow branch-a/branch-b tips to add a differing outer file,
    // preserving each commit's frontend/ subtree and Shadow-replayed-team
    // trailer. This simulates outer state arriving via a sibling pair's
    // splice — the case where composeSameRepoMergeTree has nothing to fall back
    // to.
    git("fetch origin", local);
    const shaA = git("rev-parse origin/shadow/frontend/branch-a", local);
    const shaB = git("rev-parse origin/shadow/frontend/branch-b", local);

    function injectOuter(shadowSha: string, body: string): string {
      const blob = git("hash-object -w --stdin", local, { input: body });
      const baseTree = git(`rev-parse "${shadowSha}^{tree}"`, local);
      const idx = path.join(env.tmpDir, `idx-${shadowSha.slice(0, 7)}`);
      const idxEnv = { ...process.env, GIT_INDEX_FILE: idx };
      git(`read-tree ${baseTree}`, local, { env: idxEnv });
      git(`update-index --add --cacheinfo 100644,${blob},outer.txt`, local, { env: idxEnv });
      const newTree = git("write-tree", local, { env: idxEnv });
      fs.rmSync(idx, { force: true });

      const parents = git(`log -1 --format=%P ${shadowSha}`, local).split(/\s+/).filter(Boolean);
      const msgFile = path.join(env.tmpDir, `msg-${shadowSha.slice(0, 7)}`);
      fs.writeFileSync(msgFile, git(`log -1 --format=%B ${shadowSha}`, local) + "\n");
      const pArgs = parents.map(p => `-p ${p}`).join(" ");
      const newSha = git(`commit-tree ${newTree} ${pArgs} -F "${msgFile}"`, local);
      fs.rmSync(msgFile, { force: true });
      return newSha;
    }

    const newA = injectOuter(shaA, "from-A\n");
    const newB = injectOuter(shaB, "from-B\n");
    git(`push origin ${newA}:refs/heads/shadow/frontend/branch-a --force`, local);
    git(`push origin ${newB}:refs/heads/shadow/frontend/branch-b --force`, local);

    // Source-side octopus merge of branch-a + branch-b into main.
    git("checkout main", team);
    git('merge --no-ff branch-a branch-b -m "Octopus merge"', team);
    git("push origin main", team);
    const srcMerge = git("rev-parse HEAD", team);

    // Sync must fail, naming the source SHA, mapped parents, and required trailer.
    const r2 = runCiSync(env);
    assertEqual(r2.status, 1, "[recovery] sync fails on outer divergence");
    assertIncludes(r2.stderr, "cannot auto-resolve replay parent tree", "[recovery] error names the failure");
    assertIncludes(r2.stderr, srcMerge, "[recovery] error includes full source merge SHA");
    assertIncludes(r2.stderr, newA, "[recovery] error includes mapped parent A");
    assertIncludes(r2.stderr, newB, "[recovery] error includes mapped parent B");
    assertIncludes(r2.stderr, `Shadow-replayed-${env.subdir}-${env.remoteName}: ${srcMerge}`, "[recovery] error includes required trailer");

    // ── Manual reconciliation (operator follows the recipe in the error) ──
    // Build a resolved tree: newA's tree (has frontend/base.ts, feat-a.ts,
    // outer.txt) + newB's feat-b.ts + an operator-chosen outer.txt.
    const baseShadow = git("rev-parse origin/shadow/frontend/main", local);
    const idx = path.join(env.tmpDir, "idx-resolve");
    const idxEnv = { ...process.env, GIT_INDEX_FILE: idx };
    git(`read-tree "${newA}^{tree}"`, local, { env: idxEnv });
    const featB = git(`rev-parse ${newB}:frontend/feat-b.ts`, local);
    git(`update-index --add --cacheinfo 100644,${featB},frontend/feat-b.ts`, local, { env: idxEnv });
    const outerBlob = git("hash-object -w --stdin", local, { input: "from-A+B\n" });
    git(`update-index --add --cacheinfo 100644,${outerBlob},outer.txt`, local, { env: idxEnv });
    const resolvedTree = git("write-tree", local, { env: idxEnv });
    fs.rmSync(idx, { force: true });

    const msgFile = path.join(env.tmpDir, "resolve-msg");
    fs.writeFileSync(msgFile, `Manual resolution of ${srcMerge.slice(0, 7)}\n\nShadow-replayed-${env.subdir}-${env.remoteName}: ${srcMerge}\n`);
    const resolveCommit = git(`commit-tree ${resolvedTree} -p ${baseShadow} -p ${newA} -p ${newB} -F "${msgFile}"`, local);
    fs.rmSync(msgFile, { force: true });
    git(`push origin ${resolveCommit}:refs/heads/shadow/frontend/main --force`, local);

    // Next sync sees the trailer and treats the source merge as already replayed.
    assertEqual(runCiSync(env).status, 0, "[recovery] sync succeeds after manual resolution");
    git("fetch origin", local);
    assertEqual(
      git("rev-parse origin/shadow/frontend/main", local),
      resolveCommit,
      "[recovery] shadow main tip stays at the manual resolution",
    );

    // Content checks: operator's resolved outer survived, frontend has all features.
    assertEqual(git(`show ${resolveCommit}:outer.txt`, local), "from-A+B", "[recovery] outer is operator's choice");
    assertEqual(git(`show ${resolveCommit}:frontend/feat-a.ts`, local), "a", "[recovery] feat-a present in frontend");
    assertEqual(git(`show ${resolveCommit}:frontend/feat-b.ts`, local), "b", "[recovery] feat-b present in frontend");
    assertEqual(git(`show ${resolveCommit}:frontend/base.ts`, local), "base", "[recovery] base present in frontend");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  // This file tests merge topology, not the branch filter — wildcard.
  setTestBranchAllowlist({ origin: ["**"], team: ["**"] });
  try {
    runMergeTopology();
    runEchoMapping();
    runEchoIntermediateOuter();
    runPushMergeSkippedParents();
    runSquashLocalBeforePush();
    runSquashRemoteBeforeSync();
    runSquashCrossRepoBroken();
    runSquashFeatureAbsorbsShadow();
    runManualMergeRecovery();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-merges");
}
