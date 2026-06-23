/**
 * test-halt-recovery-variants.ts — single-pair halt-and-recovery edge cases.
 *
 * Extracted from sht7 in test-scenario.ts. Each sub-test pins a specific
 * variant of the engine's halt-and-recover mechanism on a single backend pair.
 * The combined multi-pair flavor of halt-recovery lives in
 * test-scenario.ts (Phase halt-recovery); the generic single-pair
 * mechanism with operator reconciliation via Shadow-replayed-* trailer lives
 * in test-merges.ts sub-test F. The variants here exercise edge cases that
 * neither of those files covers:
 *
 *   happy-round-trip                — canonical recovery + multi-trailer squash + Bcx content survival
 *   idempotent-rerun                — --from b is a stable no-op after recovery
 *   halt-persistence                — halt diagnostic persists across reruns until recovered
 *   approach-a-still-works          — manually built shadow commit with replay trailer (Approach A) resumes
 *   multi-commit-halt-absorption    — Bm+1 (post-halt commit) inherits halt + gets absorbed in the squash
 *   halt-not-resolved-by-dropped-child — a dropped commit masks the halt; the
 *                                     kept child below it must propagate the halt
 *                                     (first-parent walk sees through the drop),
 *                                     not replay around it (ref pinned, Bm not absorbed)
 *   multi-echo-octopus-halts        — 3-parent octopus whose 2nd/3rd parents carry echo trailers halts
 *   multi-echo-octopus-recovery     — recovery from the octopus halt
 *   concurrent-outer-during-recovery — a 3rd branch touches the same outer file
 *                                     while recovering an A/B halt: ≥3 live mapped
 *                                     parents re-halt (no 2-way union) until the
 *                                     operator folds C in so the resolution dominates
 *   halted-partial-tip-first-parent — mapBranchesToTargetTips picks project-a's tip via first-parent walk
 *   fork-from-absorbed-same-run     — branch forked off a halted commit stays halted when the trunk
 *                                     squash-resolves; recovers by merging the resolved shadow ref
 *   fork-from-absorbed-late-filter  — same fork, but seen only after recovery: Shadow-absorbed
 *                                     trailers alone must scope the squash to the trunk's lineage
 *
 * Run: npx tsx shadow-tests/test-halt-recovery-variants.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { createTestEnv, runCiSync, runPush, trailerKeyOf, TestEnv } from "./harness";

async function runAll(): Promise<void> {
  function git(cmd: string, cwd: string): void {
    execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
  }
  function gitOut(cmd: string, cwd: string): string {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }
  function writeFile(dir: string, rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
  }
  function assertEqual<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  interface ConflictInfo {
    p1: string;
    p2: string;
    bm: string;
  }

  // The single replay trailer line now carries the direct-replay SHA first,
  // then any squash-absorbed source SHAs as extra space-separated values.
  function replayValues(msg: string, key: string): string[] {
    const m = msg.split("\n").find(l => l.startsWith(`${key}:`));
    return m ? m.slice(key.length + 1).trim().split(/\s+/).filter(Boolean) : [];
  }
  function assertDirectReplay(msg: string, key: string, sha: string, ctx: string): void {
    const vals = replayValues(msg, key);
    assert(vals[0] === sha, `${ctx}: expected direct replay ${sha} as first value on ${key}; got ${JSON.stringify(vals)}\n${msg}`);
  }
  function assertAbsorbed(msg: string, key: string, sha: string, ctx: string): void {
    const vals = replayValues(msg, key);
    assert(vals.slice(1).includes(sha), `${ctx}: expected absorbed ${sha} among ${key} values; got ${JSON.stringify(vals)}\n${msg}`);
  }

  /** Drive scenario through the Bm failure; return env and parsed mapped parents. */
  function setupAndFailReplay(envName: string): { env: TestEnv; info: ConflictInfo } {
    const env = createTestEnv(envName, "backend");

    git("branch -m main core-dev", env.localRepo);
    git("branch -m main core-dev", env.remoteWorking);

    // Branch allowlist (engine fails closed without one). Only core-dev + project here.
    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
      ["team",   [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
    ]));

    // BE: Bc1 on core-dev, Bp1 on project
    writeFile(env.remoteWorking, "api.ts", "v_be_initial\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bc1"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);
    git("checkout -b project core-dev~1", env.remoteWorking);
    writeFile(env.remoteWorking, "api.ts", "v_be_project\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bp1"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);

    // Initial --from b
    const r1 = runCiSync(env);
    if (r1.status !== 0) throw new Error(`initial --from b failed: ${r1.stderr}`);

    // M: Mc on core-dev, Mp on project, with frontend.txt divergent outer
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "core notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_core\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc"', env.localRepo);
    git("checkout -b project core-dev~1", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "project notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_project\n");
    git("add -A", env.localRepo);
    git('commit -m "Mp"', env.localRepo);
    git("checkout core-dev", env.localRepo);

    // --from a
    const r2 = runPush(env);
    if (r2.status !== 0) throw new Error(`--from a failed: ${r2.stderr}`);

    // BE: Bcm, Bcx, Bpm, Bm
    git("checkout core-dev", env.remoteWorking);
    git("fetch origin", env.remoteWorking);
    git('merge --no-ff origin/a-backend/core-dev -m "Bcm"', env.remoteWorking);
    writeFile(env.remoteWorking, "feature.ts", "be feature added in Bcx\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bcx"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);
    git("checkout project", env.remoteWorking);
    git('merge --no-ff origin/a-backend/project -m "Bpm"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    try {
      git('merge --no-ff project -m "Bm"', env.remoteWorking);
    } catch {
      writeFile(env.remoteWorking, "api.ts", "v_be_initial + v_be_project\n");
      writeFile(env.remoteWorking, "notes.txt", "core + project notes\n");
      git("add -A", env.remoteWorking);
      git('commit --no-edit', env.remoteWorking);
    }
    git("push origin core-dev", env.remoteWorking);

    // --from b — must fail
    const r3 = runCiSync(env);
    if (r3.status === 0) throw new Error("expected --from b to fail on Bm but it succeeded");

    // Concurrent M-side edit (Mc2)
    git("fetch origin --prune", env.localRepo);
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "frontend.txt", "v_fe_core_v2\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc2"', env.localRepo);

    const errText = r3.stdout + r3.stderr;
    const mp = errText.match(/Mapped parents on origin:\s+([0-9a-f]{40})\s+([0-9a-f]{40})/);
    if (!mp) throw new Error("could not parse mapped parents from:\n" + errText);
    const bmMatch = errText.match(/Source merge:\s+([0-9a-f]{40})/);
    if (!bmMatch) throw new Error("could not parse Bm sha");

    return { env, info: { p1: mp[1], p2: mp[2], bm: bmMatch[1] } };
  }

  /** Operator action: `git merge project` on M.core-dev. Resolves outer in-place. */
  function operatorMergeProject(env: TestEnv): string {
    git("checkout core-dev", env.localRepo);
    try {
      git('merge --no-ff project -m "Mm"', env.localRepo);
    } catch {
      writeFile(env.localRepo, "frontend.txt", "v_fe_merged_with_v2\n");
      writeFile(env.localRepo, "backend/notes.txt", "core + project notes\n");
      git("add -A", env.localRepo);
      git('commit --no-edit', env.localRepo);
    }
    git("push origin core-dev", env.localRepo);
    return gitOut("rev-parse HEAD", env.localRepo);
  }

  /**
   * Full round-trip after a halt: operator does Mm on mono; --from a propagates
   * Mm onto backend's shadow ref; backend merges that shadow ref into core-dev
   * (= R_be); returns R_be's SHA.
   */
  function roundTripResolution(env: TestEnv): { mm: string; rbe: string } {
    const mm = operatorMergeProject(env);

    // --from a propagates Mm onto backend's a-backend/core-dev as Mm'_on_be
    const r = runPush(env);
    if (r.status !== 0) throw new Error(`--from a propagation failed: ${r.stderr}`);

    // Backend merges the shadow ref into core-dev → R_be
    git("fetch origin --prune", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    try {
      git('merge --no-ff origin/a-backend/core-dev -m "R_be"', env.remoteWorking);
    } catch {
      // Inner resolutions are byte-identical between Bm and Mm'_on_be, so the
      // merge tree is clean; this catch only fires on phantom tooling conflicts.
      git("add -A", env.remoteWorking);
      git('commit --no-edit', env.remoteWorking);
    }
    git("push origin core-dev", env.remoteWorking);
    const rbe = gitOut("rev-parse HEAD", env.remoteWorking);
    return { mm, rbe };
  }

  function runHappyRoundTrip(): void {
    const { env, info } = setupAndFailReplay("roundtrip-happy");
    try {
      const { rbe } = roundTripResolution(env);
      const r = runCiSync(env);
      assertEqual(r.status, 0, `--from b status after round-trip (stderr=${r.stderr})`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assert(sqHash.length === 40, "shadow ref must exist");

      // sq's replay trailer carries R_be (direct) first, then Bm (absorbed).
      const key = trailerKeyOf(env, "b");
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);
      assertDirectReplay(sqMsg, key, rbe, "sq R_be");
      assertAbsorbed(sqMsg, key, info.bm, "sq Bm");

      // backend/feature.ts (Bcx's content) must be present on the shadow ref tree
      const feature = gitOut(`show origin/b-backend/core-dev:backend/feature.ts`, env.localRepo);
      assert(feature.includes("be feature added in Bcx"), `feature.ts missing/wrong on shadow: ${feature}`);

      // Catch-up merge: shadow tip's outer matches M.core-dev's outer (FF'd from Mm),
      // so the merge is clean — no second resolution needed.
      git("checkout core-dev", env.localRepo);
      git("merge --no-ff origin/b-backend/core-dev -m \"catch-up\"", env.localRepo);
      const localFeature = fs.readFileSync(path.join(env.localRepo, "backend/feature.ts"), "utf8");
      assert(localFeature.includes("be feature added in Bcx"), `feature.ts missing on M.core-dev`);
    } finally {
      env.cleanup();
    }
  }

  function runIdempotentRerun(): void {
    const { env, info } = setupAndFailReplay("roundtrip-idempotent");
    try {
      roundTripResolution(env);
      const r1 = runCiSync(env);
      assertEqual(r1.status, 0, `first post-roundtrip --from b status (stderr=${r1.stderr})`);
      git("fetch origin --prune", env.localRepo);
      const sq1 = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);

      const r2 = runCiSync(env);
      assertEqual(r2.status, 0, `second --from b status (stderr=${r2.stderr})`);
      git("fetch origin --prune", env.localRepo);
      const sq2 = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assertEqual(sq2, sq1, "sq SHA must be stable across re-runs");
      void info;
    } finally {
      env.cleanup();
    }
  }

  function runHaltPersistence(): void {
    const { env, info } = setupAndFailReplay("roundtrip-halt-persists");
    try {
      // Skip the round-trip — re-run --from b and verify the halt persists
      // with the same diagnostic and no spurious shadow advances.
      git("fetch origin --prune", env.localRepo);
      const tipBefore = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);

      const r = runCiSync(env);
      assert(r.status !== 0, "expected --from b to halt again without resolution");
      assert(/cannot auto-resolve replay parent tree — branch halted/.test(r.stdout + r.stderr),
        `expected halt diagnostic, got:\n${r.stdout}\n${r.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const tipAfter = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assertEqual(tipAfter, tipBefore, "shadow tip must not advance while halted");
      void info;
    } finally {
      env.cleanup();
    }
  }

  function runApproachAStillWorks(): void {
    const { env, info } = setupAndFailReplay("b-prime-approach-a");
    try {
      // Hand-build X on shadow ref with existing replay trailer (Approach A recipe)
      const { p1, p2, bm } = info;
      git(`checkout -b manual-resolve-${bm.slice(0, 7)} ${p1}`, env.localRepo);
      try {
        git(`merge --no-ff ${p2}`, env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged\n");
        writeFile(env.localRepo, "backend/notes.txt", "core + project notes\n");
        writeFile(env.localRepo, "backend/api.ts", "v_be_initial + v_be_project\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }
      const tree = gitOut("write-tree", env.localRepo);
      const key = trailerKeyOf(env, "b");
      const X = gitOut(
        `commit-tree ${tree} -p ${p1} -p ${p2} -m "Manual resolution of ${bm.slice(0, 7)}" -m "${key}: ${bm}"`,
        env.localRepo,
      );
      git(`update-ref refs/heads/b-backend/core-dev ${X}`, env.localRepo);
      git(`push origin b-backend/core-dev`, env.localRepo);
      git("checkout core-dev", env.localRepo);

      // Re-run without the flag — A should resume normally via loadReplayedMappings
      const r = runCiSync(env);
      assertEqual(r.status, 0, `A recipe --from b status (stderr=${r.stderr})`);
    } finally {
      env.cleanup();
    }
  }

  function runMultiCommitHaltAbsorption(): void {
    const { env, info } = setupAndFailReplay("roundtrip-multi-halt");
    try {
      // BE devs commit on core-dev AFTER the halt. Bm+1 is a linear child whose
      // only source parent is the halted Bm → it inherits the halt via the
      // all-parents-halted+unmapped rule, and the propagation step copies Bm's
      // mappedParents into Bm+1's halt record (the `inheritedMP` block).
      git("checkout core-dev", env.remoteWorking);
      writeFile(env.remoteWorking, "post-halt.ts", "post-halt content\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bm+1: linear commit after halt"', env.remoteWorking);
      const bmPlus1 = gitOut("rev-parse HEAD", env.remoteWorking);
      git("push origin core-dev", env.remoteWorking);

      // Second --from b — both Bm and Bm+1 halt (Bm directly; Bm+1 via propagation
      // with inherited mappedParents from Bm's halt record).
      const halt2 = runCiSync(env);
      assert(halt2.status !== 0, "expected halt after Bm+1 added");
      assert(/cannot auto-resolve replay parent tree — branch halted/.test(halt2.stdout + halt2.stderr),
        "expected halt diagnostic on second --from b");

      // Operator does the round-trip. BE.core-dev is now at Bm+1, so the
      // BE-side merge of the shadow ref produces R_be with parents [Bm+1, Mm'_on_be].
      roundTripResolution(env);

      // Third --from b — absorbs BOTH Bm and Bm+1 into the squashed shadow commit.
      const r = runCiSync(env);
      assertEqual(r.status, 0, `--from b after multi-commit halt: ${r.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assert(sqHash.length === 40, "shadow ref must exist post-absorption");
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);

      // sq's replay trailer must carry BOTH halted source SHAs (Bm AND Bm+1) as absorbed values.
      const key = trailerKeyOf(env, "b");
      assertAbsorbed(sqMsg, key, info.bm, "multi-halt Bm");
      assertAbsorbed(sqMsg, key, bmPlus1, "multi-halt Bm+1");

      // post-halt.ts (Bm+1's content) must survive in sq's tree. If
      // resolveHaltAwareParents skipped Bm+1's inherited mappedParents, or if
      // collectAbsorbedHalted didn't walk through Bm+1, the squash would lose it.
      const postHalt = gitOut(`show ${sqHash}:backend/post-halt.ts`, env.localRepo);
      assert(postHalt.includes("post-halt content"),
        `post-halt.ts missing/wrong on squashed shadow: "${postHalt}"`);

      // Re-running --from b is a no-op — loadReplayedMappings sees Bm AND Bm+1
      // via the multi-trailer encoding and filters both out of the next work list.
      const rerun = runCiSync(env);
      assertEqual(rerun.status, 0, `idempotent re-run status: ${rerun.stderr}`);
      git("fetch origin --prune", env.localRepo);
      const sqHash2 = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assertEqual(sqHash2, sqHash, "shadow tip stable across multi-trailer idempotent re-run");
    } finally {
      env.cleanup();
    }
  }

  // A dropped commit D (child of the halted Bm) followed by a kept commit C.
  // D is unmapped-but-not-halted, so a naive "are my direct parents halted"
  // check would let C replay — anchoring around Bm to ONE side and silently
  // adopting it as a resolution. Halt propagation walks each parent's
  // first-parent line through dropped commits (haltBehindParent), so C sees the
  // masked halt and propagates it: C is skipped, the shadow ref stays pinned at
  // the last faithful tip, Bm is never absorbed, and C's content never lands.
  function runHaltNotResolvedByDroppedChild(): void {
    const { env, info } = setupAndFailReplay("halt-not-resolved-dropped-child");
    try {
      git("fetch origin --prune", env.localRepo);
      const tipBefore = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);

      git("checkout core-dev", env.remoteWorking);
      git('commit --allow-empty -m "D (dropped empty commit)"', env.remoteWorking);
      writeFile(env.remoteWorking, "after.ts", "after-halt content\n");
      git("add -A", env.remoteWorking);
      git('commit -m "C (kept child of dropped D)"', env.remoteWorking);
      git("push origin core-dev", env.remoteWorking);

      const r = runCiSync(env);
      assert(r.status !== 0, "sync must fail while the halt is unresolved");
      assert(/cannot auto-resolve replay parent tree/.test(r.stdout + r.stderr),
        `halt diagnostic for Bm must persist; got:\n${r.stdout}\n${r.stderr}`);
      // C propagates the halt and is skipped cleanly — it must NOT replay and
      // then get rejected by the fast-forward guard (the old, accidental path).
      assert(!/diverged with different tree/.test(r.stdout + r.stderr),
        `C must propagate the halt, not replay-then-FF-block; got:\n${r.stdout}\n${r.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const tipAfter = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      assertEqual(tipAfter, tipBefore, "shadow ref must not advance past the halt");

      const msg = gitOut(`log -1 --format=%B ${tipAfter}`, env.localRepo);
      assert(!msg.includes(info.bm), `Bm must NOT be absorbed/replayed onto the faithful tip\n${msg}`);

      // C's content must not have leaked onto the shadow ref.
      const tree = gitOut("ls-tree -r --name-only origin/b-backend/core-dev", env.localRepo);
      assert(!tree.includes("backend/after.ts"),
        `C's content must not land while the halt is unresolved; tree:\n${tree}`);
    } finally {
      env.cleanup();
    }
  }

  // Bm is an octopus that directly merges two shadow refs (shadow/backend/core-dev
  // + shadow/backend/project) into core-dev. Both shadow-tip parents carry the
  // target-side echo trailer. Their mapped M-side targets (Mc and Mp) have
  // divergent outer state (frontend.txt). Engine must halt rather than silently
  // pick one echo's outer.
  function setupMultiEchoHalt(envName: string): { env: TestEnv; bm: string; mc: string; mp: string } {
    const env = createTestEnv(envName, "backend");
    git("branch -m main core-dev", env.localRepo);
    git("branch -m main core-dev", env.remoteWorking);

    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
      ["team",   [compileIgnorePattern("core-dev"), compileIgnorePattern("project")]],
    ]));

    // BE: Bc1 on core-dev; Bp1 on project (off the same Bc1 root).
    writeFile(env.remoteWorking, "api.ts", "v_be_initial\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bc1"', env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);

    git("checkout -b project core-dev", env.remoteWorking);
    writeFile(env.remoteWorking, "extra.ts", "v_be_project\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bp1"', env.remoteWorking);
    git("push origin project", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);

    const r1 = runCiSync(env);
    if (r1.status !== 0) throw new Error(`bootstrap --from b failed: ${r1.stderr}`);

    // Mc on core-dev, Mp on project. Disjoint inner files so the BE-side
    // octopus auto-resolves; divergent outer (frontend.txt) so the M-side
    // mapped echo targets disagree.
    git("checkout core-dev", env.localRepo);
    writeFile(env.localRepo, "backend/notes.txt", "Mc notes\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_core\n");
    git("add -A", env.localRepo);
    git('commit -m "Mc"', env.localRepo);
    const mc = gitOut("rev-parse HEAD", env.localRepo);

    git("checkout -b project core-dev~1", env.localRepo);
    writeFile(env.localRepo, "backend/feat.ts", "Mp feat\n");
    writeFile(env.localRepo, "frontend.txt", "v_fe_project\n");
    git("add -A", env.localRepo);
    git('commit -m "Mp"', env.localRepo);
    const mp = gitOut("rev-parse HEAD", env.localRepo);
    git("checkout core-dev", env.localRepo);

    const r2 = runPush(env);
    if (r2.status !== 0) throw new Error(`--from a failed: ${r2.stderr}`);

    git("checkout core-dev", env.remoteWorking);
    git("fetch origin --prune", env.remoteWorking);
    git('merge --no-ff origin/a-backend/core-dev origin/a-backend/project -m "Bm (multi-echo octopus)"', env.remoteWorking);
    const bm = gitOut("rev-parse HEAD", env.remoteWorking);
    git("push origin core-dev", env.remoteWorking);

    const r3 = runCiSync(env);
    if (r3.status === 0) throw new Error("expected --from b to halt on multi-echo octopus; it succeeded");

    return { env, bm, mc, mp };
  }

  function runMultiEchoOctopusHalts(): void {
    const { env, bm } = setupMultiEchoHalt("multi-echo-halts");
    try {
      // Precondition: Bm is a 3-parent octopus whose parents 2 and 3 carry the echo trailer.
      const bmParents = gitOut(`log -1 --format=%P ${bm}`, env.remoteWorking).split(/\s+/).filter(Boolean);
      assertEqual(bmParents.length, 3, `Bm should be a 3-parent octopus; got ${bmParents.length}`);
      const pushKey = trailerKeyOf(env, "a");
      for (const p of [bmParents[1], bmParents[2]]) {
        const trailers = gitOut(`log -1 --format=%(trailers:only) ${p}`, env.remoteWorking);
        assert(trailers.includes(`${pushKey}:`),
          `parent ${p.slice(0, 7)} missing echo trailer:\n${trailers}`);
      }

      // Re-run --from b: halt must persist with a diagnostic that names the source merge.
      const r = runCiSync(env);
      assert(r.status !== 0, "halt must persist on re-run");
      const out = r.stdout + r.stderr;
      assert(/cannot auto-resolve replay parent tree/.test(out),
        `expected halt diagnostic, got:\n${out}`);
      assert(out.includes(bm), `diagnostic should name source octopus ${bm}`);
    } finally {
      env.cleanup();
    }
  }

  function runMultiEchoOctopusRecovery(): void {
    const { env, bm } = setupMultiEchoHalt("multi-echo-recovery");
    try {
      // Operator: merge project into core-dev on mono, resolving the frontend.txt conflict.
      git("checkout core-dev", env.localRepo);
      try {
        git('merge --no-ff project -m "Mm (resolve multi-echo)"', env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }
      git("push origin core-dev", env.localRepo);

      // --from a propagates Mm onto team's shadow/backend/core-dev.
      const rA = runPush(env);
      assertEqual(rA.status, 0, `--from a propagation: ${rA.stderr}`);

      // Backend operator merges shadow back into core-dev → R_be.
      git("fetch origin --prune", env.remoteWorking);
      git("checkout core-dev", env.remoteWorking);
      try {
        git('merge --no-ff origin/a-backend/core-dev -m "R_be (catch-up after multi-echo)"', env.remoteWorking);
      } catch {
        git("add -A", env.remoteWorking);
        git('commit --no-edit', env.remoteWorking);
      }
      git("push origin core-dev", env.remoteWorking);
      const rbe = gitOut("rev-parse HEAD", env.remoteWorking);

      // --from b: succeeds, absorbing the halted Bm into the new shadow commit.
      const rB = runCiSync(env);
      assertEqual(rB.status, 0, `--from b after multi-echo recovery: ${rB.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);

      // Squashed shadow commit's replay trailer: R_be direct, Bm absorbed.
      const key = trailerKeyOf(env, "b");
      assertDirectReplay(sqMsg, key, rbe, "multi-echo R_be");
      assertAbsorbed(sqMsg, key, bm, "multi-echo Bm");

      // Tree content: api.ts (from Bc1) + notes.txt (from Mc) + feat.ts (from Mp).
      assertEqual(gitOut(`show ${sqHash}:backend/api.ts`, env.localRepo), "v_be_initial",
        "api.ts present in absorbed shadow tip");
      assertEqual(gitOut(`show ${sqHash}:backend/notes.txt`, env.localRepo), "Mc notes",
        "notes.txt (Mc inner) present in absorbed shadow tip");
      assertEqual(gitOut(`show ${sqHash}:backend/feat.ts`, env.localRepo), "Mp feat",
        "feat.ts (Mp inner) present in absorbed shadow tip");
    } finally {
      env.cleanup();
    }
  }

  // A/B halt recovered, but a THIRD branch C touches the SAME outer file
  // (frontend.txt) concurrently. The operator is only told to reconcile the
  // divergent A/B pair (Mc vs Mp); C never appears in that diagnostic. Folding
  // just the A/B resolution back leaves C as a live, non-dominated mapped parent
  // at recovery — reconcileOuter then sees ≥3 mapped parents (so its 2-way outer
  // union is unavailable) with no dominator, and RE-HALTS on a fresh merge.
  // Recovery is only possible once the operator ALSO merges C, so the resolution
  // dominates it (the union path can never save a ≥3-parent reconcile).
  function runConcurrentOuterDuringRecovery(): void {
    const { env, bm } = setupMultiEchoHalt("concurrent-outer-recovery");
    try {
      // Allow the config branch too (setup only allowed core-dev + project).
      setBranchFiltersForTesting(new Map([
        ["origin", [compileIgnorePattern("core-dev"), compileIgnorePattern("project"), compileIgnorePattern("config")]],
        ["team",   [compileIgnorePattern("core-dev"), compileIgnorePattern("project"), compileIgnorePattern("config")]],
      ]));

      // Operator resolves ONLY the A/B (core-dev vs project) frontend conflict.
      git("checkout core-dev", env.localRepo);
      try {
        git('merge --no-ff project -m "Mm (resolve A/B frontend)"', env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }

      // C: a third branch off the pre-Mc root that touches the SAME outer file
      // (frontend.txt) concurrently — never part of the A/B resolution.
      git("checkout -b config core-dev~1", env.localRepo);
      writeFile(env.localRepo, "frontend.txt", "v_fe_config\n");
      writeFile(env.localRepo, "backend/cfg.ts", "Mx cfg\n");
      git("add -A", env.localRepo);
      git('commit -m "Mx (concurrent outer on C)"', env.localRepo);
      git("checkout core-dev", env.localRepo);

      // Propagate Mm -> a-backend/core-dev and Mx -> a-backend/config.
      const rA = runPush(env);
      assertEqual(rA.status, 0, `--from a propagation: ${rA.stderr}`);

      // BE catch-up folds in BOTH the resolution echo and C's echo.
      git("fetch origin --prune", env.remoteWorking);
      git("checkout core-dev", env.remoteWorking);
      try {
        git('merge --no-ff origin/a-backend/core-dev origin/a-backend/config -m "R_be (catch-up + C)"', env.remoteWorking);
      } catch {
        git("add -A", env.remoteWorking);
        git('commit --no-edit', env.remoteWorking);
      }
      const rbe = gitOut("rev-parse HEAD", env.remoteWorking);
      git("push origin core-dev", env.remoteWorking);

      // --from b RE-HALTS: ≥3 live mapped parents, no dominator, no 2-way union.
      const rHalt = runCiSync(env);
      assert(rHalt.status !== 0, "concurrent C on the same outer must re-halt the recovery merge");
      const out = rHalt.stdout + rHalt.stderr;
      assert(/cannot auto-resolve replay parent tree/.test(out),
        `expected a fresh halt diagnostic; got:\n${out}`);
      assert(out.includes(rbe), `re-halt diagnostic should name the catch-up merge ${rbe}\n${out}`);

      // The shadow tip must NOT have advanced past the unresolved outer — C's
      // content must not leak onto it while recovery is incomplete.
      git("fetch origin --prune", env.localRepo);
      const treeMid = gitOut("ls-tree -r --name-only origin/b-backend/core-dev", env.localRepo);
      assert(!treeMid.includes("backend/cfg.ts"),
        `C content must not land while recovery is unresolved; tree:\n${treeMid}`);

      // Resolution: operator now ALSO merges C, so the resolution dominates it.
      git("checkout core-dev", env.localRepo);
      try {
        git('merge --no-ff config -m "Mm2 (fold in C)"', env.localRepo);
      } catch {
        writeFile(env.localRepo, "frontend.txt", "v_fe_merged_all\n");
        git("add -A", env.localRepo);
        git('commit --no-edit', env.localRepo);
      }
      const rA2 = runPush(env);
      assertEqual(rA2.status, 0, `--from a (post-fold) propagation: ${rA2.stderr}`);

      git("fetch origin --prune", env.remoteWorking);
      git("checkout core-dev", env.remoteWorking);
      try {
        git('merge --no-ff origin/a-backend/core-dev -m "R_be2 (catch-up after folding C)"', env.remoteWorking);
      } catch {
        git("add -A", env.remoteWorking);
        git('commit --no-edit', env.remoteWorking);
      }
      git("push origin core-dev", env.remoteWorking);

      const rOk = runCiSync(env);
      assertEqual(rOk.status, 0, `recovery after folding C must succeed: ${rOk.stderr}`);

      // The squash absorbs the original octopus Bm; C's inner content lands.
      git("fetch origin --prune", env.localRepo);
      const sqHash = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);
      const key = trailerKeyOf(env, "b");
      assertAbsorbed(sqMsg, key, bm, "concurrent-outer Bm");
      assertEqual(gitOut(`show ${sqHash}:backend/cfg.ts`, env.localRepo), "Mx cfg",
        "C inner (cfg.ts) present after dominator recovery");
    } finally {
      env.cleanup();
    }
  }

  function runHaltedPartialTipFirstParent(): void {
    // Topology: backend has project-a + project-b. Bm = `git merge project-b`
    // on project-a creates a 2-parent merge whose mapped parents on mono
    // disagree on outer state (README.md) → halt. After halt,
    // mapBranchesToTargetTips must pick project-a's newest mapped ancestor as
    // the partial tip — which is Bp1x' (last project-a commit before Bm). If
    // the function walks full topo-order instead of first-parent, the walk
    // crosses into project-b's history via Bm's second-parent edge and
    // returns Bp2m' instead — a project-b commit that isn't an ancestor of
    // shadow/backend/project-a's current tip, so the FF push fails.
    const env = createTestEnv("partial-tip-first-parent", "backend");
    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("main"), compileIgnorePattern("project-*")]],
      ["team",   [compileIgnorePattern("main"), compileIgnorePattern("project-*")]],
    ]));

    try {
      // BE: Bc1 on main; Bp1 on project-a; Bp2 on project-b (off Bc1).
      writeFile(env.remoteWorking, "init.txt", "init\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bc1"', env.remoteWorking);
      git("push origin main", env.remoteWorking);

      git("checkout -b project-a", env.remoteWorking);
      writeFile(env.remoteWorking, "feat-a.ts", "feat a\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bp1"', env.remoteWorking);
      git("push origin project-a", env.remoteWorking);

      git("checkout -b project-b main", env.remoteWorking);
      writeFile(env.remoteWorking, "feat-b.ts", "feat b\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bp2"', env.remoteWorking);
      git("push origin project-b", env.remoteWorking);
      git("checkout main", env.remoteWorking);

      const r1 = runCiSync(env);
      if (r1.status !== 0) throw new Error(`bootstrap --from b failed: ${r1.stderr}`);

      // M-side: Mp1c on project-a (README=v_a), Mp2c on project-b (README=v_b).
      // Outer divergence is what causes Bm to halt later.
      git("checkout -b project-a", env.localRepo);
      writeFile(env.localRepo, "README.md", "v_a\n");
      writeFile(env.localRepo, "backend/release-notes.txt", "release a\n");
      git("add -A", env.localRepo);
      git('commit -m "Mp1c"', env.localRepo);

      git("checkout -b project-b main", env.localRepo);
      writeFile(env.localRepo, "README.md", "v_b\n");
      writeFile(env.localRepo, "backend/release-notes.txt", "release b\n");
      git("add -A", env.localRepo);
      git('commit -m "Mp2c"', env.localRepo);
      git("checkout project-a", env.localRepo);

      const r2 = runPush(env);
      if (r2.status !== 0) throw new Error(`--from a failed: ${r2.stderr}`);

      // BE operator: Bp1m + Bp1x on project-a, Bp2m on project-b.
      git("fetch origin --prune", env.remoteWorking);
      git("checkout project-a", env.remoteWorking);
      git('merge --no-ff origin/a-backend/project-a -m "Bp1m"', env.remoteWorking);
      writeFile(env.remoteWorking, "feat-a-extra.ts", "extra\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bp1x"', env.remoteWorking);
      git("push origin project-a", env.remoteWorking);

      git("checkout project-b", env.remoteWorking);
      git('merge --no-ff origin/a-backend/project-b -m "Bp2m"', env.remoteWorking);
      git("push origin project-b", env.remoteWorking);

      // Bm = merge project-b INTO project-a. Conflict on release-notes.txt.
      git("checkout project-a", env.remoteWorking);
      try {
        git('merge --no-ff project-b -m "Bm"', env.remoteWorking);
      } catch {
        writeFile(env.remoteWorking, "release-notes.txt", "release a + release b\n");
        git("add -A", env.remoteWorking);
        git('commit --no-edit', env.remoteWorking);
      }
      git("push origin project-a", env.remoteWorking);

      // --from b must halt on Bm. Push of project-a's partial tip must
      // succeed (FF push of Bp1x', NOT Bp2m').
      const r3 = runCiSync(env);
      assert(r3.status !== 0, "expected --from b to halt on Bm");
      assert(/cannot auto-resolve replay parent tree/.test(r3.stdout + r3.stderr),
        `expected halt diagnostic in:\n${r3.stdout}\n${r3.stderr}`);
      assert(!/diverged with different tree/.test(r3.stdout + r3.stderr),
        `partial-tip FF push must NOT diverge; output:\n${r3.stdout}\n${r3.stderr}`);

      // Shadow/backend/project-a partial tip must carry project-a's content
      // (feat-a-extra.ts from Bp1x), NOT project-b's (feat-b.ts which would
      // be present only if Bp2m' was picked as the partial tip).
      git("fetch origin --prune", env.localRepo);
      const tree = gitOut("ls-tree -r --name-only origin/b-backend/project-a", env.localRepo);
      assert(tree.includes("backend/feat-a-extra.ts"),
        `partial tip must be Bp1x' (has feat-a-extra.ts); tree:\n${tree}`);
      assert(!tree.includes("backend/feat-b.ts"),
        `partial tip must NOT be project-b's Bp2m' (would include feat-b.ts); tree:\n${tree}`);
    } finally {
      env.cleanup();
    }
  }

  /** "hash path" entries of a tree's inner slice, prefix stripped, sorted. */
  function innerTree(cwd: string, ref: string, prefix = ""): string[] {
    const raw = gitOut(`ls-tree -r ${ref}${prefix ? ` -- ${prefix}` : ""}`, cwd);
    return raw.split("\n").filter(Boolean).map(line => {
      const [meta, p] = line.split("\t");
      const hash = meta.split(/\s+/)[2];
      return `${hash} ${prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p}`;
    }).sort();
  }

  /** Fork `side` off the halted Bm with one commit Bs1; returns Bs1's SHA. */
  function forkSideFromHalt(env: TestEnv, bm: string): string {
    git(`checkout -b side ${bm}`, env.remoteWorking);
    writeFile(env.remoteWorking, "side.ts", "side work v1\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bs1"', env.remoteWorking);
    const bs1 = gitOut("rev-parse HEAD", env.remoteWorking);
    git("push origin side", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    return bs1;
  }

  /** Operator recovery for a stranded fork: merge the resolved branch's
   *  shadow ref into side (the ref carries the resolution echo). */
  function mergeShadowIntoSide(env: TestEnv): string {
    git("fetch origin --prune", env.remoteWorking);
    git("checkout side", env.remoteWorking);
    try {
      git('merge --no-ff origin/a-backend/core-dev -m "Sm"', env.remoteWorking);
    } catch {
      git("add -A", env.remoteWorking);
      git('commit --no-edit', env.remoteWorking);
    }
    git("push origin side", env.remoteWorking);
    const sm = gitOut("rev-parse HEAD", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    return sm;
  }

  /** Fork `side` off the halted Bm, but interpose a DROPPED (empty) commit D so
   *  Bm is reached only via D's first-parent line — never as Bs1's direct
   *  parent. Returns Bs1's SHA. */
  function forkSideBehindDroppedCommit(env: TestEnv, bm: string): string {
    git(`checkout -b side ${bm}`, env.remoteWorking);
    git('commit --allow-empty -m "D (dropped empty commit on side)"', env.remoteWorking);
    writeFile(env.remoteWorking, "side.ts", "side work v1\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Bs1 (kept child of dropped D)"', env.remoteWorking);
    const bs1 = gitOut("rev-parse HEAD", env.remoteWorking);
    git("push origin side", env.remoteWorking);
    git("checkout core-dev", env.remoteWorking);
    return bs1;
  }

  // Same foreign-squash situation as fork-from-absorbed-late-filter, but with a
  // DROPPED commit interposed between the absorbed Bm and the fork's kept commit
  // Bs1. Bs1's direct parent is now the dropped D, so resolveHaltAwareParents
  // takes its unmapped-parent first-parent WALK (which omits absorbedMap from its
  // stop set, unlike haltBehindParent) instead of the direct absorbed-entries
  // branch. The fork is in the identical foreign-squash predicament as the direct
  // case, so it MUST halt the same way; replaying Bs1 anchored past the absorbed
  // Bm would be a silent content lie.
  function runForkFromAbsorbedMaskedByDropped(): void {
    const { env, info } = setupAndFailReplay("fork-absorbed-masked-dropped");
    try {
      const bs1 = forkSideBehindDroppedCommit(env, info.bm);

      // Trunk recovers while side is invisible to the engine; Bm is absorbed
      // into the squash and persisted via the absorbed trailer.
      roundTripResolution(env);
      const r1 = runCiSync(env);
      assertEqual(r1.status, 0, `recovery sync (side not in filter): ${r1.stderr}`);
      git("fetch origin --prune", env.localRepo);
      const sq = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);

      // side enters the filter. The masked-absorbed fork must halt exactly like
      // the direct fork-from-absorbed case.
      setBranchFiltersForTesting(new Map([
        ["origin", ["core-dev", "project", "side"].map(compileIgnorePattern)],
        ["team",   ["core-dev", "project", "side"].map(compileIgnorePattern)],
      ]));
      const r2 = runCiSync(env);
      assert(r2.status !== 0, "masked-absorbed fork must halt, not replay past the squash");
      const out = r2.stdout + r2.stderr;
      assert(/squash-resolved on another (branch|lineage)/.test(out),
        `expected absorbed-elsewhere diagnostic, got:\n${out}`);

      git("fetch origin --prune", env.localRepo);
      const sideTip = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      assert(sideTip !== sq, "stranded fork must not be created at the squash");
      const tree = gitOut("ls-tree -r --name-only origin/b-backend/side", env.localRepo);
      assert(!tree.includes("backend/side.ts"),
        `faithful partial tip must predate Bs1; tree:\n${tree}`);
    } finally {
      env.cleanup();
    }
  }

  // One absorber (R_be) resolves TWO halts at once — Bm and its propagated
  // child Bm+1 — while a fork hangs off the EARLIER halt Bm. When the trunk
  // squash absorbs both, the fork must fire the foreign-squash halt against ITS
  // ancestor (Bm), not the other absorbed halt (Bm+1). resolveAbsorbedParent
  // looks up absorbedMap keyed on the fork's actual parent, so the entry it
  // finds — and the Halted-ancestor / anchor it records — must be Bm's.
  function runForkOffOneOfTwoAbsorbedHalts(): void {
    const { env, info } = setupAndFailReplay("fork-off-one-of-two-halts");
    try {
      setBranchFiltersForTesting(new Map([
        ["origin", ["core-dev", "project", "side"].map(compileIgnorePattern)],
        ["team",   ["core-dev", "project", "side"].map(compileIgnorePattern)],
      ]));

      // Fork side off the earlier halt Bm (before Bm+1 exists).
      const bs1 = forkSideFromHalt(env, info.bm);

      // Bm+1: a linear child of Bm on core-dev → a second (propagated) halt.
      git("checkout core-dev", env.remoteWorking);
      writeFile(env.remoteWorking, "post-halt.ts", "post-halt content\n");
      git("add -A", env.remoteWorking);
      git('commit -m "Bm+1: linear commit after halt"', env.remoteWorking);
      const bmPlus1 = gitOut("rev-parse HEAD", env.remoteWorking);
      git("push origin core-dev", env.remoteWorking);

      // Both halts (Bm, Bm+1) plus the stranded fork are present.
      const h = runCiSync(env);
      assert(h.status !== 0, "expected halts (Bm, Bm+1) + stranded fork");
      git("fetch origin --prune", env.localRepo);
      const sideTipBefore = gitOut("rev-parse origin/b-backend/side", env.localRepo);

      // Trunk round-trip: R_be absorbs BOTH Bm and Bm+1 into one squash.
      roundTripResolution(env);
      const r = runCiSync(env);
      assert(r.status !== 0, "fork stranded off Bm must halt while the trunk absorbs both halts");
      const out = r.stdout + r.stderr;
      assert(/squash-resolved on another (branch|lineage)/.test(out),
        `expected absorbed-elsewhere diagnostic; got:\n${out}`);

      // The right entry: the halt is attributed to the fork's ancestor Bm, NOT
      // the other absorbed halt Bm+1.
      assert(new RegExp(`Halted ancestor:\\s+${info.bm}`).test(out),
        `diagnostic must name Bm as the halted ancestor; got:\n${out}`);
      assert(!new RegExp(`Halted ancestor:\\s+${bmPlus1}`).test(out),
        `the fork's halt must NOT be attributed to Bm+1; got:\n${out}`);

      // Fork ref must not move to the squash.
      git("fetch origin --prune", env.localRepo);
      const sq = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      const sideTipAfter = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      assertEqual(sideTipAfter, sideTipBefore, "stranded fork ref must not move");
      assert(sideTipAfter !== sq, "stranded fork must not inherit the squash");

      // Recovery: merge the resolution into side → absorbs Bs1, and the fork tip
      // gets the squash (Bm's anchor) as a parent.
      const sm = mergeShadowIntoSide(env);
      const r2 = runCiSync(env);
      assertEqual(r2.status, 0, `sync after fork recovery: ${r2.stderr}`);
      git("fetch origin --prune", env.localRepo);
      const sideTip = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      const sideMsg = gitOut(`log -1 --format=%B ${sideTip}`, env.localRepo);
      const key = trailerKeyOf(env, "b");
      assertDirectReplay(sideMsg, key, sm, "fork-off-two Sm");
      assertAbsorbed(sideMsg, key, bs1, "fork-off-two Bs1");
      const parents = gitOut(`log -1 --format=%P ${sideTip}`, env.localRepo).split(/\s+/);
      assert(parents.includes(sq),
        `fork tip must have the squash ${sq.slice(0, 7)} (Bm's anchor) as a parent; got ${parents.join(" ")}`);
    } finally {
      env.cleanup();
    }
  }

  // A branch forks off the halted Bm; the trunk recovers via the squash. The
  // fork must NOT inherit the squash (silent content lie) — it halts with the
  // absorbed-elsewhere diagnostic until the resolution is merged into it.
  function runForkFromAbsorbedSameRun(): void {
    const { env, info } = setupAndFailReplay("fork-absorbed-same-run");
    try {
      setBranchFiltersForTesting(new Map([
        ["origin", ["core-dev", "project", "side"].map(compileIgnorePattern)],
        ["team",   ["core-dev", "project", "side"].map(compileIgnorePattern)],
      ]));
      const bs1 = forkSideFromHalt(env, info.bm);

      // Pre-recovery sync: original halt persists; side's partial tip is the
      // last faithful commit (Bcx'), pinned for the no-move assertion below.
      const h = runCiSync(env);
      assert(h.status !== 0, "expected halt to persist with side in filter");
      git("fetch origin --prune", env.localRepo);
      const sideTipBefore = gitOut("rev-parse origin/b-backend/side", env.localRepo);

      const { mm } = roundTripResolution(env);

      // Recovery sync: trunk resolves into the squash, but the fork is now
      // stranded — run must FAIL with the promoted diagnostic, and the fork's
      // shadow ref must NOT move to the squash.
      const r = runCiSync(env);
      assert(r.status !== 0, "recovery sync must fail while the fork is stranded");
      const out = r.stdout + r.stderr;
      assert(/squash-resolved on another (branch|lineage)/.test(out),
        `expected absorbed-elsewhere diagnostic, got:\n${out}`);
      git("fetch origin --prune", env.localRepo);
      const sq = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);
      const sideTipAfter = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      assertEqual(sideTipAfter, sideTipBefore, "stranded fork's shadow ref must not move");
      assert(sideTipAfter !== sq, "stranded fork's shadow ref must not inherit the squash");

      // Operator merges the resolution into side → next sync absorbs Bs1.
      const sm = mergeShadowIntoSide(env);
      const r2 = runCiSync(env);
      assertEqual(r2.status, 0, `sync after fork recovery: ${r2.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sideTip = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      const sideMsg = gitOut(`log -1 --format=%B ${sideTip}`, env.localRepo);
      const key = trailerKeyOf(env, "b");
      assertDirectReplay(sideMsg, key, sm, "side Sm");
      assertAbsorbed(sideMsg, key, bs1, "side Bs1");

      // Parents: [squash (Bs1's anchor), Mm (echo of the merged shadow ref)].
      const parents = gitOut(`log -1 --format=%P ${sideTip}`, env.localRepo).split(/\s+/);
      assertEqual(parents.join(" "), `${sq} ${mm}`, "side tip parents = [sq, Mm]");

      // Tree fidelity: the shadow's inner slice equals Sm's source tree exactly
      // — fork content present, nothing leaked from commits the fork never had.
      const src = innerTree(env.remoteWorking, sm);
      const shadow = innerTree(env.localRepo, sideTip, "backend/");
      assertEqual(shadow.join("\n"), src.join("\n"), "shadow side tree must equal source side tree");

      // Idempotent re-run.
      const r3 = runCiSync(env);
      assertEqual(r3.status, 0, `idempotent re-run: ${r3.stderr}`);
      git("fetch origin --prune", env.localRepo);
      assertEqual(gitOut("rev-parse origin/b-backend/side", env.localRepo), sideTip,
        "side tip stable across re-runs");
    } finally {
      env.cleanup();
    }
  }

  // Same fork, but the branch enters the filter only AFTER the trunk
  // recovered — there is no in-run halt state, so the foreign-squash check
  // must come from the Shadow-absorbed trailers alone.
  function runForkFromAbsorbedLateFilter(): void {
    const { env, info } = setupAndFailReplay("fork-absorbed-late-filter");
    try {
      const bs1 = forkSideFromHalt(env, info.bm);

      // Trunk recovers while side is invisible to the engine.
      roundTripResolution(env);
      const r1 = runCiSync(env);
      assertEqual(r1.status, 0, `recovery sync (side not in filter): ${r1.stderr}`);
      git("fetch origin --prune", env.localRepo);
      const sq = gitOut("rev-parse origin/b-backend/core-dev", env.localRepo);

      // side enters the filter: trailer-derived scoping must halt the fork.
      setBranchFiltersForTesting(new Map([
        ["origin", ["core-dev", "project", "side"].map(compileIgnorePattern)],
        ["team",   ["core-dev", "project", "side"].map(compileIgnorePattern)],
      ]));
      const r2 = runCiSync(env);
      assert(r2.status !== 0, "first sync with side in filter must halt the stranded fork");
      const out = r2.stdout + r2.stderr;
      assert(/squash-resolved on another (branch|lineage)/.test(out),
        `expected absorbed-elsewhere diagnostic, got:\n${out}`);

      // The fork's shadow ref is created at the last FAITHFUL tip — neither
      // the squash nor a tree containing the fork's unsynced work.
      git("fetch origin --prune", env.localRepo);
      const sideTip = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      assert(sideTip !== sq, "stranded fork must not be created at the squash");
      const tree = gitOut("ls-tree -r --name-only origin/b-backend/side", env.localRepo);
      assert(!tree.includes("backend/side.ts"), `faithful partial tip must predate Bs1; tree:\n${tree}`);
      assert(!tree.includes("backend/post-halt.ts"), `no squash content may leak onto the fork; tree:\n${tree}`);

      // Recovery: merge the resolved shadow ref into side, then re-sync.
      const sm = mergeShadowIntoSide(env);
      const r3 = runCiSync(env);
      assertEqual(r3.status, 0, `sync after fork recovery: ${r3.stderr}`);

      git("fetch origin --prune", env.localRepo);
      const sideTip2 = gitOut("rev-parse origin/b-backend/side", env.localRepo);
      const sideMsg = gitOut(`log -1 --format=%B ${sideTip2}`, env.localRepo);
      assertAbsorbed(sideMsg, trailerKeyOf(env, "b"), bs1, "late-filter side Bs1");
      const src = innerTree(env.remoteWorking, sm);
      const shadow = innerTree(env.localRepo, sideTip2, "backend/");
      assertEqual(shadow.join("\n"), src.join("\n"), "shadow side tree must equal source side tree");
    } finally {
      env.cleanup();
    }
  }

  const subs: Array<[string, () => void]> = [
    ["happy-round-trip", runHappyRoundTrip],
    ["idempotent-rerun", runIdempotentRerun],
    ["halt-persistence", runHaltPersistence],
    ["approach-a-still-works", runApproachAStillWorks],
    ["multi-commit-halt-absorption", runMultiCommitHaltAbsorption],
    ["halt-not-resolved-by-dropped-child", runHaltNotResolvedByDroppedChild],
    ["multi-echo-octopus-halts", runMultiEchoOctopusHalts],
    ["multi-echo-octopus-recovery", runMultiEchoOctopusRecovery],
    ["concurrent-outer-during-recovery", runConcurrentOuterDuringRecovery],
    ["halted-partial-tip-first-parent", runHaltedPartialTipFirstParent],
    ["fork-from-absorbed-same-run", runForkFromAbsorbedSameRun],
    ["fork-from-absorbed-late-filter", runForkFromAbsorbedLateFilter],
    ["fork-from-absorbed-masked-by-dropped", runForkFromAbsorbedMaskedByDropped],
    ["fork-off-one-of-two-absorbed-halts", runForkOffOneOfTwoAbsorbedHalts],
  ];
  let failed = 0;
  try {
    for (const [name, fn] of subs) {
      try { fn(); console.log(`    ✓ ${name}`); }
      catch (e: any) { console.error(`    ✘ ${name}: ${e.message}`); failed++; }
    }
  } finally {
    setBranchFiltersForTesting(null);
  }
  if (failed > 0) throw new Error(`halt-recovery-variants: ${failed}/${subs.length} sub-test(s) failed`);
}

export default async function run(): Promise<void> {
  await runAll();
}

if (require.main === module) {
  run().then(() => console.log("PASS  test-halt-recovery-variants"))
       .catch(err => { console.error(err); process.exit(1); });
}
