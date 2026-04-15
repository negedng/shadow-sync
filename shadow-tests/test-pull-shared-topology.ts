import { createTestEnv, runCiSync } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: when the external repo merges a feature branch into main, the shared
 * commits (including the merge commit) appear on both shadow branches with
 * correct topology — shared ancestors use the same local SHA, not duplicates.
 *
 * External history:
 *   A ─ B ─ E ─ F (main)        ← F is the merge commit
 *        └─ C ─ D ┘ (feature)
 *
 * After CI sync, the shadow branches should share the local equivalents
 * of A, B, C, D — not have independent copies.
 */
export default function run() {
  const env = createTestEnv("pull-shared-topo");
  try {
    // ── Build external history ──────────────────────────────────────────

    // A: initial commit (already created by harness)
    // B: commit on main
    fs.writeFileSync(path.join(env.remoteWorking, "main.ts"), "main v1\n");
    git("add main.ts", env.remoteWorking);
    git('commit -m "B: add main.ts"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Create feature branch from B
    git("checkout -b feature/merge-test", env.remoteWorking);

    // C: first feature commit
    fs.writeFileSync(path.join(env.remoteWorking, "feat.ts"), "feat v1\n");
    git("add feat.ts", env.remoteWorking);
    git('commit -m "C: add feat.ts"', env.remoteWorking);

    // D: second feature commit
    fs.writeFileSync(path.join(env.remoteWorking, "feat.ts"), "feat v2\n");
    git("add feat.ts", env.remoteWorking);
    git('commit -m "D: update feat.ts"', env.remoteWorking);
    git("push origin feature/merge-test", env.remoteWorking);

    // E: another commit on main (parallel to feature work)
    git("checkout main", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "main.ts"), "main v2\n");
    git("add main.ts", env.remoteWorking);
    git('commit -m "E: update main.ts"', env.remoteWorking);

    // F: merge feature into main
    git("merge feature/merge-test --no-ff -m \"F: merge feature into main\"", env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── Run CI sync ─────────────────────────────────────────────────────

    const r = runCiSync(env);
    assertEqual(r.status, 0, "ci-sync should succeed");

    // ── Verify content on both shadow branches ──────────────────────────

    git("fetch origin", env.localRepo);

    const mainShadow = "origin/shadow/frontend/main";
    const featShadow = "origin/shadow/frontend/feature/merge-test";

    // Main shadow should have both main.ts and feat.ts (merged)
    const mainTs = git(`show ${mainShadow}:frontend/main.ts`, env.localRepo);
    assertEqual(mainTs, "main v2", "main shadow should have main.ts v2");

    const featTsOnMain = git(`show ${mainShadow}:frontend/feat.ts`, env.localRepo);
    assertEqual(featTsOnMain, "feat v2", "main shadow should have feat.ts (merged from feature)");

    // Feature shadow should have feat.ts and main.ts (from before branch point)
    const featTs = git(`show ${featShadow}:frontend/feat.ts`, env.localRepo);
    assertEqual(featTs, "feat v2", "feature shadow should have feat.ts v2");

    const mainTsOnFeat = git(`show ${featShadow}:frontend/main.ts`, env.localRepo);
    assertEqual(mainTsOnFeat, "main v1", "feature shadow should have main.ts v1 (pre-branch)");

    // ── Verify shared topology ──────────────────────────────────────────
    // The key assertion: commits shared between branches should have the
    // SAME local SHA on both shadow branches, proving they weren't duplicated.

    // Find the synced SHA for commit B on main's shadow branch
    const mainLog = git(`log --format=%H%n%B ${mainShadow} -- frontend/`, env.localRepo);
    const featLog = git(`log --format=%H%n%B ${featShadow} -- frontend/`, env.localRepo);

    // Extract local SHAs that synced "B: add main.ts"
    const bOnMain = extractLocalSHAForMessage(mainLog, "B: add main.ts");
    const bOnFeat = extractLocalSHAForMessage(featLog, "B: add main.ts");
    assertEqual(bOnMain, bOnFeat, "commit B should have the SAME local SHA on both shadow branches (shared topology)");

    // Extract local SHAs for "C: add feat.ts" — should also be shared
    // (C is on feature directly, and reachable from main via merge)
    const cOnMain = extractLocalSHAForMessage(mainLog, "C: add feat.ts");
    const cOnFeat = extractLocalSHAForMessage(featLog, "C: add feat.ts");
    assertEqual(cOnMain, cOnFeat, "commit C should have the SAME local SHA on both shadow branches (shared topology)");

    // ── Verify merge commit structure ───────────────────────────────────
    // The merge commit F on main's shadow should have 2 parents
    const fSHA = extractLocalSHAForMessage(mainLog, "F: merge feature into main");
    const parentCount = git(`rev-list --parents -1 ${fSHA}`, env.localRepo)
      .split(/\s+/).length - 1;  // first is the commit itself, rest are parents
    assertEqual(parentCount, 2, "merge commit F should have 2 parents on shadow branch");

    // ── Re-sync should be a no-op ───────────────────────────────────────
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "re-sync should succeed");

  } finally {
    env.cleanup();
  }
}

/**
 * Given `git log --format=%H%n%B` output, find the local SHA of the commit
 * whose message starts with the given prefix.
 */
function extractLocalSHAForMessage(log: string, messagePrefix: string): string {
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(messagePrefix)) {
      // Walk back to find the SHA — it's the first 40-hex line above this message
      for (let j = i - 1; j >= 0; j--) {
        if (/^[0-9a-f]{40}$/.test(lines[j])) {
          return lines[j];
        }
      }
    }
  }
  throw new Error(`Could not find commit with message prefix "${messagePrefix}" in log`);
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-shared-topology");
}
