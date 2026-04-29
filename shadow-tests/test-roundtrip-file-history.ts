import { createTestEnv, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Round-trip with conflict resolution: verify that `git log -- file` on the
 * Realogic side, after a Fornax-side conflict resolution round-trips back,
 * shows the *individual* commits (a, b, c', m') — not just the merge.
 *
 * Scenario:
 *   1. Realogic (A) writes commits a, b — both modify dir/file.ts.
 *   2. Push A→B. Replay creates a', b' on B's shadow.
 *   3. Fornax (B) writes commit c that modifies file.ts at root (concurrent
 *      modification on the same lines as a/b).
 *   4. Fornax merges shadow into main. The merge conflicts; the human resolves
 *      it as merge commit m on B/main.
 *   5. Pull B→A. Replay walks B/main:
 *        - c → c' on Realogic shadow (parents [b via fallbackParent])
 *        - m → m' on Realogic shadow (parents [c', b via echo])
 *      M9's splice fires on m' because b' (m's source second parent) is echo'd.
 *   6. Realogic merges shadow into main.
 *   7. `git log -- dir/file.ts` from Realogic main must include a, b, c', m'.
 */
export default function run() {
  const env = createTestEnv("roundtrip-file-history");
  try {
    const filePath = path.join(env.localRepo, env.subdir, "file.ts");

    // ── Step 1: A writes a, b ────────────────────────────────────────────
    fs.writeFileSync(filePath, "v0\nv0\nv0\n");
    git(`add ${env.subdir}/file.ts`, env.localRepo);
    git('commit -m "a: A modifies file.ts"', env.localRepo);
    const aHash = git("rev-parse HEAD", env.localRepo);

    fs.writeFileSync(filePath, "v0\nv-from-A\nv0\n");
    git(`add ${env.subdir}/file.ts`, env.localRepo);
    git('commit -m "b: A further modifies file.ts"', env.localRepo);
    const bHash = git("rev-parse HEAD", env.localRepo);

    git("push origin main", env.localRepo);

    // ── Step 2: Push A→B ─────────────────────────────────────────────────
    const r1 = runPush(env);
    assertEqual(r1.status, 0, "[step 2] push A→B should succeed");

    // ── Step 3: B writes c (modifies same lines, will conflict on merge) ─
    const remoteFile = path.join(env.remoteWorking, "file.ts");
    git("pull origin main", env.remoteWorking);
    fs.writeFileSync(remoteFile, "v0\nv-from-B\nv0\n");
    git("add file.ts", env.remoteWorking);
    git('commit -m "c: B modifies file.ts on its own"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── Step 4: B fetches shadow, merges it, resolves conflict as m ──────
    git(`fetch origin shadow/${env.subdir}/main`, env.remoteWorking);
    // Attempt merge — should conflict.
    try {
      git(`merge --no-ff origin/shadow/${env.subdir}/main -m "m: merge shadow with conflict"`, env.remoteWorking);
      throw new Error("[step 4] merge should have conflicted but did not");
    } catch (err) {
      // Expected: merge fails with conflict. Resolve manually.
    }
    // Human resolves: take B's content but acknowledge A's contribution.
    fs.writeFileSync(remoteFile, "v0\nv-resolved-by-B\nv0\n");
    git("add file.ts", env.remoteWorking);
    git('commit -m "m: merge shadow with conflict (resolved)"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // ── Step 5: Pull B→A. M9 fires on the merge commit. ──────────────────
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[step 5] pull B→A should succeed");

    // ── Step 6: Realogic merges shadow into main ─────────────────────────
    mergeShadow(env);

    // ── Step 7: Verify history of dir/file.ts ────────────────────────────
    // `git log -- dir/file.ts` should walk back through all commits that
    // touched the file. We expect to see a, b, c' (replay of c), m' (replay
    // of m) — the individual commits, not just a single merge.
    const fileLog = git(`log --format=%H --all -- ${env.subdir}/file.ts`, env.localRepo);
    const fileCommits = fileLog.split("\n").filter(Boolean);

    // a and b are unchanged on Realogic side; their original SHAs should appear.
    assertIncludes(
      fileCommits.join("\n"), aHash,
      "[step 7] file history must include a (A's first commit)",
    );
    assertIncludes(
      fileCommits.join("\n"), bHash,
      "[step 7] file history must include b (A's second commit)",
    );

    // c' and m' are replays — we identify them by message.
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
    assertEqual(cPrime != null, true, "[step 7] c' (replay of c) should exist on Realogic");
    assertEqual(mPrime != null, true, "[step 7] m' (replay of m) should exist on Realogic");
    assertIncludes(
      fileCommits.join("\n"), cPrime!,
      "[step 7] file history must include c' (B's commit replayed onto Realogic)",
    );
    assertIncludes(
      fileCommits.join("\n"), mPrime!,
      "[step 7] file history must include m' (B's resolution merge replayed)",
    );

    // Sanity: the file on A's main now has B's resolved content.
    const finalContent = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    assertEqual(
      finalContent, "v0\nv-resolved-by-B\nv0\n",
      "[step 7] file.ts should have B's resolved content after merge",
    );

    if (process.env.DEBUG_FILE_HISTORY) {
      console.log("\n[debug] git log -- dir/file.ts on Realogic main:");
      console.log(git(`log --oneline -- ${env.subdir}/file.ts`, env.localRepo));
      console.log("\n[debug] graph:");
      console.log(git(`log --graph --oneline --all`, env.localRepo));
    }
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-roundtrip-file-history");
}
