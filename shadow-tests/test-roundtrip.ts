/**
 * Consolidated round-trip test. Two sub-tests:
 *
 *   A. round-trip — full A→B→merge→B→A; commit originating from A is not
 *      re-replayed on the way back (echo skipped).
 *      (formerly test-round-trip.ts)
 *   B. file-history — same shape, but with B-side conflict resolution; verify
 *      `git log -- file` on A includes the individual commits a, b, c', m'
 *      after the round-trip.
 *      (formerly test-roundtrip-file-history.ts)
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush, readExternalShadowFile,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── A. round-trip: A→B→merge→B→A; A's commit not re-replayed ──────────────
function runRoundTrip(): void {
  const env = createTestEnv("round-trip", "frontend", "shadow", "src");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[round-trip] initial pull should succeed");
    mergeShadow(env);

    commitOnLocal(env, { "from-a.ts": "local feature\n" }, "Add from-a.ts");

    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[round-trip] push A->B should succeed");

    assertEqual(readExternalShadowFile(env, "from-a.ts"), "local feature\n",
      "[round-trip] file should be on B shadow");

    const subdir = env.subdir;
    const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge origin/${shadowBranch} --no-ff -m "Merge shadow into B main"`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[round-trip] pull B->A should succeed");

    const shadowLog = git(`fetch origin ${shadowBranch} && git log origin/${shadowBranch} --oneline -10`, env.localRepo);
    const fromACount = (shadowLog.match(/Add from-a\.ts/g) || []).length;
    assertEqual(fromACount <= 1, true,
      "[round-trip] from-a.ts commit should not be duplicated on shadow branch");
  } finally {
    env.cleanup();
  }
}

// ── B. file-history: round-trip with conflict resolution + log -- file ─────
function runRoundtripFileHistory(): void {
  const env = createTestEnv("roundtrip-file-history");
  try {
    const filePath = path.join(env.localRepo, env.subdir, "file.ts");

    // Step 1: A writes a, b
    fs.writeFileSync(filePath, "v0\nv0\nv0\n");
    git(`add ${env.subdir}/file.ts`, env.localRepo);
    git('commit -m "a: A modifies file.ts"', env.localRepo);
    const aHash = git("rev-parse HEAD", env.localRepo);

    fs.writeFileSync(filePath, "v0\nv-from-A\nv0\n");
    git(`add ${env.subdir}/file.ts`, env.localRepo);
    git('commit -m "b: A further modifies file.ts"', env.localRepo);
    const bHash = git("rev-parse HEAD", env.localRepo);

    git("push origin main", env.localRepo);

    // Step 2: Push A→B
    const r1 = runPush(env);
    assertEqual(r1.status, 0, "[file-hist step 2] push A→B should succeed");

    // Step 3: B writes c (modifies same lines, will conflict on merge)
    const remoteFile = path.join(env.remoteWorking, "file.ts");
    git("pull origin main", env.remoteWorking);
    fs.writeFileSync(remoteFile, "v0\nv-from-B\nv0\n");
    git("add file.ts", env.remoteWorking);
    git('commit -m "c: B modifies file.ts on its own"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Step 4: B fetches shadow, attempts merge (conflicts), resolves manually
    git(`fetch origin shadow/${env.subdir}/main`, env.remoteWorking);
    try {
      git(`merge --no-ff origin/shadow/${env.subdir}/main -m "m: merge shadow with conflict"`,
          env.remoteWorking);
      throw new Error("[file-hist step 4] merge should have conflicted but did not");
    } catch {
      // Expected
    }
    fs.writeFileSync(remoteFile, "v0\nv-resolved-by-B\nv0\n");
    git("add file.ts", env.remoteWorking);
    git('commit -m "m: merge shadow with conflict (resolved)"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Step 5: Pull B→A. M1 fires on the merge commit.
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[file-hist step 5] pull B→A should succeed");

    // Step 6: A merges shadow into main
    mergeShadow(env);

    // Step 7: Verify history of dir/file.ts shows individual commits
    const fileLog = git(`log --format=%H --all -- ${env.subdir}/file.ts`, env.localRepo);
    const fileCommits = fileLog.split("\n").filter(Boolean);

    assertIncludes(fileCommits.join("\n"), aHash,
      "[file-hist step 7] file history must include a (A's first commit)");
    assertIncludes(fileCommits.join("\n"), bHash,
      "[file-hist step 7] file history must include b (A's second commit)");

    const allCommitsLog = git(`log --format="%H %s" --all`, env.localRepo);
    const findByMessage = (substr: string): string | null => {
      for (const line of allCommitsLog.split("\n")) {
        const idx = line.indexOf(" ");
        const sha = line.slice(0, idx);
        const msg = line.slice(idx + 1);
        if (msg.includes(substr)) return sha;
      }
      return null;
    };
    const cPrime = findByMessage("c: B modifies file.ts on its own");
    const mPrime = findByMessage("m: merge shadow with conflict");
    assertEqual(cPrime != null, true,
      "[file-hist step 7] c' (replay of c) should exist on A");
    assertEqual(mPrime != null, true,
      "[file-hist step 7] m' (replay of m) should exist on A");
    assertIncludes(fileCommits.join("\n"), cPrime!,
      "[file-hist step 7] file history must include c'");
    assertIncludes(fileCommits.join("\n"), mPrime!,
      "[file-hist step 7] file history must include m'");

    const finalContent = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    assertEqual(finalContent, "v0\nv-resolved-by-B\nv0\n",
      "[file-hist step 7] file.ts should have B's resolved content");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  runRoundTrip();
  runRoundtripFileHistory();
}

if (require.main === module) {
  run();
  console.log("PASS  test-roundtrip");
}
