import { createTestEnv, runCiSync, readShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated merge-topology test. Three phases in one env — each builds a
 * new branch off main, verifies topology after merge, then proceeds.
 *
 *   1. shared-topology — merging feature-A into main shares SHAs across
 *      main shadow and feature-A shadow (no commit duplication)
 *   2. evil-merge — merge commit with edits absent from either parent;
 *      shadow tree reflects the evil edit (not reconstruction from parents)
 *   3. octopus-merge — 4-parent merge (main + f1 + f2 + f3) preserved on shadow
 */
export default function run() {
  const env = createTestEnv("pull-merge-topology");
  try {
    // ── phase 1: shared-topology ────────────────────────────────────────
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
    assertEqual(r1.status, 0, "[phase 1: shared-topology] ci-sync should succeed");

    git("fetch origin", env.localRepo);
    const mainShadow = "origin/shadow/frontend/main";
    const featShadow = "origin/shadow/frontend/feature/merge-test";

    assertEqual(git(`show ${mainShadow}:frontend/main.ts`, env.localRepo), "main v2", "[phase 1] main.ts v2 on main shadow");
    assertEqual(git(`show ${mainShadow}:frontend/feat.ts`, env.localRepo), "feat v2", "[phase 1] feat.ts on main shadow (merged)");
    assertEqual(git(`show ${featShadow}:frontend/feat.ts`, env.localRepo), "feat v2", "[phase 1] feat.ts v2 on feature shadow");
    assertEqual(git(`show ${featShadow}:frontend/main.ts`, env.localRepo), "main v1", "[phase 1] main.ts v1 on feature shadow");

    // Shared SHAs — commit B and C should have same local SHA on both branches
    const mainLog = git(`log --format=%H%n%B ${mainShadow} -- frontend/`, env.localRepo);
    const featLog = git(`log --format=%H%n%B ${featShadow} -- frontend/`, env.localRepo);
    const bOnMain = extractLocalSHA(mainLog, "B: add main.ts");
    const bOnFeat = extractLocalSHA(featLog, "B: add main.ts");
    assertEqual(bOnMain, bOnFeat, "[phase 1] B has shared SHA on both shadow branches");
    const cOnMain = extractLocalSHA(mainLog, "C: add feat.ts");
    const cOnFeat = extractLocalSHA(featLog, "C: add feat.ts");
    assertEqual(cOnMain, cOnFeat, "[phase 1] C has shared SHA on both shadow branches");

    // Merge commit F has 2 parents
    const fSHA = extractLocalSHA(mainLog, "F: merge feature into main");
    const fParents = git(`rev-list --parents -1 ${fSHA}`, env.localRepo).split(/\s+/).length - 1;
    assertEqual(fParents, 2, "[phase 1] F is a 2-parent merge commit");

    // ── phase 2: evil-merge ─────────────────────────────────────────────
    // Create evil2.ts on main, branch "evil-feat" adds evil-feat.ts, then
    // merge introduces an edit to evil2.ts that's absent from either parent.
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
    assertEqual(r2.status, 0, "[phase 2: evil-merge] ci-sync should succeed");
    assertEqual(readShadowFile(env, "evil-feat.ts"), "ef\n", "[phase 2] evil-feat.ts on main shadow");
    assertEqual(readShadowFile(env, "evil2.ts"), "evil2 EVIL\n", "[phase 2] evil edit preserved on shadow");

    git("fetch origin shadow/frontend/main", env.localRepo);
    const evilParents = git("log -1 --format=%P origin/shadow/frontend/main", env.localRepo)
      .split(/\s+/).filter(Boolean).length;
    assertEqual(evilParents, 2, "[phase 2] evil merge tip is 2-parent");

    // ── phase 3: octopus-merge (4 parents: main + f1 + f2 + f3) ─────────
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
    assertEqual(r3.status, 0, "[phase 3: octopus-merge] ci-sync should succeed");
    assertEqual(readShadowFile(env, "oct-f1.ts"), "oct-f1\n", "[phase 3] oct-f1.ts on shadow");
    assertEqual(readShadowFile(env, "oct-f2.ts"), "oct-f2\n", "[phase 3] oct-f2.ts on shadow");
    assertEqual(readShadowFile(env, "oct-f3.ts"), "oct-f3\n", "[phase 3] oct-f3.ts on shadow");
    git("fetch origin shadow/frontend/main", env.localRepo);
    const octParents = git("log -1 --format=%P origin/shadow/frontend/main", env.localRepo)
      .split(/\s+/).filter(Boolean).length;
    assertEqual(octParents, 4, "[phase 3] shadow main tip is 4-parent octopus merge");
  } finally {
    env.cleanup();
  }
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

if (require.main === module) {
  run();
  console.log("PASS  test-pull-merge-topology");
}
