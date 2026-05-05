import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush,
} from "./harness";
import { assertEqual, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Comprehensive scan of normal-use scenarios that could potentially
 * produce non-FF divergence on shadow refs. Each scenario must complete
 * without halting (status 0) and without ever producing a "diverged with
 * different tree" message — substitution + the splice formula + same-tree
 * skip should keep every push FF or no-op.
 *
 * Each scenario has its own env so state doesn't bleed between phases.
 *
 * Phases:
 *   A. Concurrent merges with DIFFERENT conflict resolutions —
 *      substitution falls through (tree mismatch); engine builds synthetic
 *      merge that must still FF via the splice formula.
 *   B. Asymmetric timing — Mira merges + commits linearly, then Bea adds
 *      linear work and does a real 3-way merge after the engine pushed.
 *   D. Cross-cutting commit (touches root files AND the synced dir).
 *   E. Repeated `--no-ff` merges of shadow when content is unchanged.
 *   F. Multiple concurrent merge rounds back-to-back.
 *   G. Linear-only alternating commits, no merges (sanity check).
 *   H. Mira FF-merges shadow (no merge commit), then commits more, then sync.
 *
 * Squash-merge by consumer is intentionally NOT tested here — it produces
 * a state where the next mergeShadow's merge commit is TREESAME to its
 * shadow-side parent at the path, which interacts with rev-list's history
 * simplification in a way the engine doesn't currently handle. Out of scope.
 */

function expectAllSyncsFF(label: string, syncs: { status: number | null; stdout: string; stderr: string }[]): void {
  for (let i = 0; i < syncs.length; i++) {
    const r = syncs[i];
    assertEqual(r.status, 0, `[${label}] sync #${i + 1} should succeed (got status=${r.status})`);
    assertNotIncludes(r.stdout + r.stderr, "diverged with different tree",
      `[${label}] sync #${i + 1} should not halt with different-tree divergence`);
  }
}

function phaseA_differentConflictResolutions(): void {
  const env = createTestEnv("nofp-A-conflict-resolutions");
  const syncs: any[] = [];
  try {
    // Both sides start with the same file
    commitOnRemote(env, { "config.txt": "version=1\nshared=base\n" }, "Initial config");
    syncs.push(runCiSync(env));
    mergeShadow(env);

    // Concurrent edits to the SAME LINE
    commitOnLocal(env, { "config.txt": "version=1\nshared=mira_choice\n" }, "Mira: shared=mira_choice");
    commitOnRemote(env, { "config.txt": "version=1\nshared=bea_choice\n" }, "Bea: shared=bea_choice");

    // Sync each direction — each shadow now has the OTHER side's content
    syncs.push(runCiSync(env));
    syncs.push(runPush(env));

    // Bea merges shadow with conflict, resolves to HER choice (--strategy-option ours)
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    try {
      git(`merge --no-ff -X ours origin/${shadowBranch} -m "Bea: merge shadow (ours wins)"`, env.remoteWorking);
    } catch {
      // -X ours should auto-resolve, but if it didn't:
      fs.writeFileSync(path.join(env.remoteWorking, "config.txt"), "version=1\nshared=bea_choice\n");
      git("add config.txt", env.remoteWorking);
      git('commit -m "Bea: resolved conflict to bea_choice"', env.remoteWorking);
    }
    git("push origin main", env.remoteWorking);

    // Mira merges shadow with conflict, resolves to HER choice
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    try {
      git(`merge --no-ff -X ours origin/${shadowBranch} -m "Mira: merge shadow (ours wins)"`, env.localRepo);
    } catch {
      fs.writeFileSync(path.join(env.localRepo, env.subdir, "config.txt"), "version=1\nshared=mira_choice\n");
      git(`add ${env.subdir}/config.txt`, env.localRepo);
      git('commit -m "Mira: resolved conflict to mira_choice"', env.localRepo);
    }

    // Now the merges have DIFFERENT trees (different conflict resolutions).
    // Substitution must fall through; engine builds synthetic; pushes still FF.
    syncs.push(runCiSync(env));
    syncs.push(runPush(env));

    // Add another commit on each side and sync to ensure stability
    commitOnLocal(env, { "mira-followup.txt": "after\n" }, "Mira: followup");
    commitOnRemote(env, { "bea-followup.txt": "after\n" }, "Bea: followup");
    syncs.push(runCiSync(env));
    syncs.push(runPush(env));

    expectAllSyncsFF("A:different-conflict-resolutions", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseB_asymmetricTiming(): void {
  const env = createTestEnv("nofp-B-asymmetric");
  const syncs: any[] = [];
  try {
    commitOnLocal(env, { "mira1.txt": "Mira 1\n" }, "Mira: mira1");
    commitOnRemote(env, { "bea1.txt": "Bea 1\n" }, "Bea: bea1");
    syncs.push(runCiSync(env));
    syncs.push(runPush(env));

    // Mira merges shadow, then makes more linear commits
    mergeShadow(env);
    commitOnLocal(env, { "mira-extra.txt": "Mira extra\n" }, "Mira: extra after merge");
    commitOnLocal(env, { "mira-extra2.txt": "Mira extra2\n" }, "Mira: extra2");

    // --from a pushes Mira's chain to backend's shadow before Bea merges
    syncs.push(runPush(env));

    // Bea adds linear work BEFORE merging
    commitOnRemote(env, { "bea-extra.txt": "Bea extra\n" }, "Bea: extra before merge");

    // Now Bea merges shadow — real 3-way merge (her main has bea1+bea-extra, shadow has full chain)
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --no-ff origin/${shadowBranch} -m "Bea: merge shadow"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    syncs.push(runCiSync(env));

    // One more cycle to confirm stability
    commitOnLocal(env, { "mira-final.txt": "final\n" }, "Mira: final");
    syncs.push(runPush(env));
    mergeShadow(env);
    syncs.push(runCiSync(env));

    expectAllSyncsFF("B:asymmetric-timing", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseD_crossCuttingCommit(): void {
  const env = createTestEnv("nofp-D-cross-cutting");
  const syncs: any[] = [];
  try {
    // Initial baseline
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: base");
    syncs.push(runCiSync(env));
    mergeShadow(env);

    // Mira makes a CROSS-CUTTING commit: touches both root and dir/
    fs.writeFileSync(path.join(env.localRepo, "ROOT-readme.md"), "root only\n");
    fs.writeFileSync(path.join(env.localRepo, env.subdir, "in-dir.txt"), "in dir\n");
    git(`add ROOT-readme.md ${env.subdir}/in-dir.txt`, env.localRepo);
    git('commit -m "Mira: cross-cutting (root + dir)"', env.localRepo);

    // --from a should replay the dir/ part to backend's shadow, FF
    syncs.push(runPush(env));

    // Mira adds another commit only touching root — engine should skip (no dir change)
    fs.writeFileSync(path.join(env.localRepo, "ROOT-only.md"), "root only 2\n");
    git("add ROOT-only.md", env.localRepo);
    git('commit -m "Mira: root-only commit"', env.localRepo);
    syncs.push(runPush(env));

    // Bea adds work, sync back
    commitOnRemote(env, { "bea-followup.txt": "after\n" }, "Bea: followup");
    syncs.push(runCiSync(env));
    mergeShadow(env);
    syncs.push(runPush(env));

    expectAllSyncsFF("D:cross-cutting", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseE_repeatedNoFFMerges(): void {
  const env = createTestEnv("nofp-E-repeated-merge");
  const syncs: any[] = [];
  try {
    commitOnRemote(env, { "x.txt": "x\n" }, "Bea: x");
    syncs.push(runCiSync(env));
    mergeShadow(env);

    // Repeat: sync (no new content) + mergeShadow several times
    for (let i = 0; i < 3; i++) {
      syncs.push(runCiSync(env));
      // --no-ff merge of an unchanged shadow — git should say "Already up to date"
      // even with --no-ff when shadow == main
      const subdir = env.subdir;
      const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
      git(`fetch origin ${shadowBranch}`, env.localRepo);
      try {
        git(`merge --no-ff origin/${shadowBranch} -m "Mira: redundant merge ${i}"`, env.localRepo);
      } catch {
        // "Already up to date" is fine
      }
      syncs.push(runPush(env));
    }

    expectAllSyncsFF("E:repeated-no-ff-merges", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseF_multipleConcurrentRounds(): void {
  const env = createTestEnv("nofp-F-multi-concurrent");
  const syncs: any[] = [];
  try {
    for (let round = 1; round <= 3; round++) {
      commitOnLocal(env, { [`mira-r${round}.txt`]: `Mira round ${round}\n` }, `Mira: r${round}`);
      commitOnRemote(env, { [`bea-r${round}.txt`]: `Bea round ${round}\n` }, `Bea: r${round}`);
      syncs.push(runCiSync(env));
      syncs.push(runPush(env));

      // BOTH merge concurrently (the b53efbd shape, but in a loop)
      const subdir = env.subdir;
      const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
      git(`fetch origin ${shadowBranch}`, env.remoteWorking);
      git(`merge --no-ff origin/${shadowBranch} -m "Bea: merge shadow r${round}"`, env.remoteWorking);
      git("push origin main", env.remoteWorking);
      mergeShadow(env);

      syncs.push(runCiSync(env));
      syncs.push(runPush(env));
    }
    expectAllSyncsFF("F:multi-concurrent-rounds", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseG_linearAlternating(): void {
  const env = createTestEnv("nofp-G-linear-alternating");
  const syncs: any[] = [];
  try {
    // Initial baseline so both sides have the dir
    commitOnRemote(env, { "base.txt": "base\n" }, "Bea: base");
    syncs.push(runCiSync(env));
    mergeShadow(env);

    // Strict alternating: Mira, sync, Bea, sync, Mira, sync, ...
    for (let i = 0; i < 4; i++) {
      commitOnLocal(env, { [`mira-${i}.txt`]: `m${i}\n` }, `Mira: ${i}`);
      syncs.push(runPush(env));

      commitOnRemote(env, { [`bea-${i}.txt`]: `b${i}\n` }, `Bea: ${i}`);
      syncs.push(runCiSync(env));
      mergeShadow(env);
    }
    expectAllSyncsFF("G:linear-alternating", syncs);
  } finally {
    env.cleanup();
  }
}

function phaseH_FFMergeThenLinear(): void {
  const env = createTestEnv("nofp-H-ff-merge");
  const syncs: any[] = [];
  try {
    commitOnRemote(env, { "x.txt": "x\n" }, "Bea: x");
    syncs.push(runCiSync(env));

    // Mira does a plain (FF-able) merge of shadow — no --no-ff. Her main FFs to shadow tip.
    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    git(`merge origin/${shadowBranch}`, env.localRepo);

    // Mira commits more on top
    commitOnLocal(env, { "mira-after.txt": "after\n" }, "Mira: after FF");

    // --from a — should see Mira's commits including the FF'd shadow tip's content
    syncs.push(runPush(env));

    // Bea continues
    commitOnRemote(env, { "bea-after.txt": "after\n" }, "Bea: after");
    syncs.push(runCiSync(env));
    mergeShadow(env);
    syncs.push(runPush(env));

    expectAllSyncsFF("H:ff-merge-then-linear", syncs);
  } finally {
    env.cleanup();
  }
}

export default function run() {
  phaseA_differentConflictResolutions();
  phaseB_asymmetricTiming();
  phaseD_crossCuttingCommit();
  phaseE_repeatedNoFFMerges();
  phaseF_multipleConcurrentRounds();
  phaseG_linearAlternating();
  phaseH_FFMergeThenLinear();
}

if (require.main === module) {
  run();
  console.log("PASS  test-no-force-push-cases");
}
