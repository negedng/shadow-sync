/**
 * test-conflict-squash-b-prime.ts — B' auto-detect (composed squash) scenarios.
 *
 * Topology (see local_tests/conflict_squash/IMPLEMENTATION_PLAN.md):
 *   BE makes Bc1 + Bp1; engine syncs to M; M makes Mc + Mp; engine syncs to BE;
 *   BE merges shadow → core-dev (Bcm) and shadow → project (Bpm), with a post-Bcm
 *   edit Bcx; BE then merges project → core-dev (Bm); engine fails on Bm because
 *   the mapped parents disagree on outer state.
 *
 * Each sub-test runs in its own env. Tests requiring B' set SHADOW_ALLOW_COMPOSED_SQUASH=1.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createTestEnv, runCiSync, runPush, TestEnv } from "./harness";

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

/** Drive scenario through the Bm failure; return env and parsed mapped parents. */
function setupAndFailReplay(envName: string): { env: TestEnv; info: ConflictInfo } {
  const env = createTestEnv(envName, "backend");

  git("branch -m main core-dev", env.localRepo);
  git("branch -m main core-dev", env.remoteWorking);

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
  git('merge --no-ff origin/shadow/backend/core-dev -m "Bcm"', env.remoteWorking);
  writeFile(env.remoteWorking, "feature.ts", "be feature added in Bcx\n");
  git("add -A", env.remoteWorking);
  git('commit -m "Bcx"', env.remoteWorking);
  git("push origin core-dev", env.remoteWorking);
  git("checkout project", env.remoteWorking);
  git('merge --no-ff origin/shadow/backend/project -m "Bpm"', env.remoteWorking);
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

function runHappyAutoDetect(): void {
  const { env, info } = setupAndFailReplay("b-prime-happy");
  try {
    operatorMergeProject(env);
    process.env.SHADOW_ALLOW_COMPOSED_SQUASH = "1";
    const r = runCiSync(env);
    delete process.env.SHADOW_ALLOW_COMPOSED_SQUASH;
    assertEqual(r.status, 0, `--from b status (stderr=${r.stderr})`);

    git("fetch origin --prune", env.localRepo);
    const sqHash = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
    assert(sqHash.length === 40, "shadow ref must exist");

    // sq must carry the replay trailer pointing at Bm
    const sqMsg = gitOut(`log -1 --format=%B ${sqHash}`, env.localRepo);
    assert(sqMsg.includes(`Shadow-replayed-backend-team: ${info.bm}`),
      `sq missing trailer for ${info.bm}\n${sqMsg}`);

    // backend/feature.ts (Bcx's content) must be present on the shadow ref tree
    const feature = gitOut(`show origin/shadow/backend/core-dev:backend/feature.ts`, env.localRepo);
    assert(feature.includes("be feature added in Bcx"), `feature.ts missing/wrong on shadow: ${feature}`);

    // Catch-up merge: shadow tip's outer matches M.core-dev's outer (same as Mm.tree),
    // so the merge is clean — no second resolution needed.
    git("merge --no-ff origin/shadow/backend/core-dev -m \"catch-up\"", env.localRepo);
    const localFeature = fs.readFileSync(path.join(env.localRepo, "backend/feature.ts"), "utf8");
    assert(localFeature.includes("be feature added in Bcx"), `feature.ts missing on M.core-dev`);
  } finally {
    env.cleanup();
  }
}

function runIdempotentRerun(): void {
  const { env, info } = setupAndFailReplay("b-prime-idempotent");
  try {
    operatorMergeProject(env);
    process.env.SHADOW_ALLOW_COMPOSED_SQUASH = "1";
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, `first --from b status (stderr=${r1.stderr})`);
    git("fetch origin --prune", env.localRepo);
    const sq1 = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);

    const r2 = runCiSync(env);
    delete process.env.SHADOW_ALLOW_COMPOSED_SQUASH;
    assertEqual(r2.status, 0, `second --from b status (stderr=${r2.stderr})`);
    git("fetch origin --prune", env.localRepo);
    const sq2 = gitOut("rev-parse origin/shadow/backend/core-dev", env.localRepo);
    assertEqual(sq2, sq1, "sq SHA must be stable across re-runs");
    void info;
  } finally {
    env.cleanup();
  }
}

function runAmbiguousCandidates(): void {
  const { env } = setupAndFailReplay("b-prime-ambiguous");
  try {
    // Two operator-authored merges on M.core-dev, both with parents[1] reachable
    // from origin/project: the natural Mm (`git merge project`) plus a second
    // merge of project after a new project commit lands.
    operatorMergeProject(env);

    // New commit on project (Mp2), then merge again on core-dev.
    git("checkout project", env.localRepo);
    writeFile(env.localRepo, "backend/p2.txt", "p2\n");
    git("add -A", env.localRepo);
    git('commit -m "Mp2"', env.localRepo);
    git("push origin project", env.localRepo);
    git("checkout core-dev", env.localRepo);
    git('merge --no-ff project -m "Mm-extra"', env.localRepo);
    git("push origin core-dev", env.localRepo);

    process.env.SHADOW_ALLOW_COMPOSED_SQUASH = "1";
    const r = runCiSync(env);
    delete process.env.SHADOW_ALLOW_COMPOSED_SQUASH;
    assert(r.status !== 0, "expected --from b to fail on ambiguous candidates");
    assert(/ambiguous resolution candidates/.test(r.stdout + r.stderr),
      `expected ambiguity error, got:\n${r.stdout}\n${r.stderr}`);

    // Disambiguate with --using
    const candidates = (r.stdout + r.stderr).match(/[0-9a-f]{40}/g) ?? [];
    assert(candidates.length >= 2, `expected >=2 candidate SHAs printed, got ${candidates.length}`);
    process.env.SHADOW_ALLOW_COMPOSED_SQUASH = "1";
    // Pick the natural Mm — the one whose parents[1] is project's tip
    const projectTip = gitOut("rev-parse project", env.localRepo);
    const mmNatural = candidates.find(c => {
      const parents = gitOut(`log -1 --format=%P ${c}`, env.localRepo).split(/\s+/);
      return parents[1] === projectTip;
    });
    assert(!!mmNatural, `could not find natural Mm among ${candidates.join(",")}`);

    // Re-invoke with --using via runSync's options path: harness's runCiSync
    // doesn't expose flags, so build the env override directly via require.
    const { runSync } = require("../shadow-sync");
    const { applyTestOverrides } = require("../shadow-common");
    applyTestOverrides({
      repoRoot: env.localRepo,
      pairs: [{
        name: env.subdir,
        a: { remote: "origin", url: env.originBare, dir: env.subdir },
        b: { remote: env.remoteName, url: env.remoteBare, dir: "" },
      }],
      shadowBranchPrefix: env.branchPrefix,
    });
    const r2 = runSync({ from: "b", pair: env.subdir, using: [mmNatural!] });
    delete process.env.SHADOW_ALLOW_COMPOSED_SQUASH;
    assertEqual(r2.exitCode, 0, `--from b --using ${mmNatural} status (stderr=${r2.stderr})`);
  } finally {
    env.cleanup();
  }
}

function runNoCandidateFallthrough(): void {
  const { env } = setupAndFailReplay("b-prime-no-candidate");
  try {
    // Skip operator merge — there's nothing for auto-detect to find.
    process.env.SHADOW_ALLOW_COMPOSED_SQUASH = "1";
    const r = runCiSync(env);
    delete process.env.SHADOW_ALLOW_COMPOSED_SQUASH;
    assert(r.status !== 0, "expected --from b to fail with no candidate");
    // Original error message must still appear
    assert(/cannot auto-resolve replay parent tree/.test(r.stdout + r.stderr),
      `expected original error, got:\n${r.stdout}\n${r.stderr}`);
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
    const X = gitOut(
      `commit-tree ${tree} -p ${p1} -p ${p2} -m "Manual resolution of ${bm.slice(0, 7)}" -m "Shadow-replayed-backend-team: ${bm}"`,
      env.localRepo,
    );
    git(`update-ref refs/heads/shadow/backend/core-dev ${X}`, env.localRepo);
    git(`push origin shadow/backend/core-dev`, env.localRepo);
    git("checkout core-dev", env.localRepo);

    // Re-run without the flag — A should resume normally via loadReplayedMappings
    const r = runCiSync(env);
    assertEqual(r.status, 0, `A recipe --from b status (stderr=${r.stderr})`);
  } finally {
    env.cleanup();
  }
}

async function main(): Promise<void> {
  const subs: Array<[string, () => void]> = [
    ["happy-auto-detect", runHappyAutoDetect],
    ["idempotent-rerun", runIdempotentRerun],
    ["ambiguous-candidates", runAmbiguousCandidates],
    ["no-candidate-fallthrough", runNoCandidateFallthrough],
    ["approach-a-still-works", runApproachAStillWorks],
  ];
  let failed = 0;
  for (const [name, fn] of subs) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (e: any) {
      console.error(`  ✘ ${name}: ${e.message}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.log(`FAIL  test-conflict-squash-b-prime (${failed}/${subs.length} sub-test(s) failed)`);
    process.exit(1);
  }
  console.log("PASS  test-conflict-squash-b-prime");
}

main().catch(err => { console.error(err); process.exit(1); });
