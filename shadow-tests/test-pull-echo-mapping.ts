import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: echo commits resolve to their original target-side hash, not the
 * target's current branch tip via fallback.
 *
 * Phase 1 — no-ff merge with an earlier B-side commit (diagram scenario):
 *   A/main:  init --- b
 *   B/main:  seed --- a --- merge(a, b') --- c
 * The replayed merge must have the original `b` commit as its second parent
 * (not A/main's current tip).
 *
 * Phase 2 — FF merge with no extra B commits (round-trip no-op):
 *   A/main:  init --- c
 *   B/main:  seed --- c'  (b FF-merged the shadow)
 * Syncing B → A has no new commits to replay, but the echo mapping must
 * still advance shadow/pair/main on A to point at A's original `c`.
 */
export default function run() {
  const env = createTestEnv("pull-echo-mapping");
  try {
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;

    // ── Phase 1: no-ff merge with B-side commit before it ─────────────────

    // 1. Establish baseline — seed B with something then pull to create the shadow branch
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[phase 1] initial pull should succeed");
    mergeShadow(env);

    // 2. A commits `b` locally (origin side)
    commitOnLocal(env, { "from-a.ts": "A's work\n" }, "b: add from-a.ts");
    const hashB = git("rev-parse HEAD", env.localRepo);

    // 3. Push A → B (creates b' on team/shadow/frontend/main with trailer)
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "[phase 1] push A→B should succeed");

    // 4. On B side: commit `a` on main BEFORE the merge, then merge b' in,
    //    then commit `c` after the merge.
    fs.writeFileSync(path.join(env.remoteWorking, "b-pre.ts"), "B before merge\n");
    git("add b-pre.ts", env.remoteWorking);
    git('commit -m "a: B commit before merge"', env.remoteWorking);

    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge origin/${shadowBranch} --no-ff -m "merge shadow into B main"`, env.remoteWorking);

    fs.writeFileSync(path.join(env.remoteWorking, "b-post.ts"), "B after merge\n");
    git("add b-post.ts", env.remoteWorking);
    git('commit -m "c: B commit after merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // 5. Advance A/main past `b` — simulates A moving on before the next sync.
    //    This is the case where the old fallback-to-tip logic would wire
    //    the replayed merge's parent to this new tip instead of `b`.
    commitOnLocal(env, { "a-after.ts": "A keeps going\n" }, "A: post-b work");
    const hashAfterB = git("rev-parse HEAD", env.localRepo);

    // 6. Pull B → A. The echo of b' should map back to `b` (not to hashAfterB).
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "[phase 1] pull B→A should succeed");

    // 7. Verify: origin/shadow/frontend/main contains the ORIGINAL `b` commit
    //    in its ancestry — reachable via the replayed merge's second parent.
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTip1 = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    const ancestors1 = git(`rev-list ${shadowTip1}`, env.localRepo).split("\n");
    assertIncludes(
      ancestors1.join("\n"),
      hashB,
      "[phase 1] original `b` hash must appear in shadow branch ancestry",
    );
    assertEqual(
      ancestors1.includes(hashAfterB),
      false,
      "[phase 1] post-b tip must NOT appear in shadow ancestry (would indicate fallback leak)",
    );

    // ── Phase 2: FF merge with no extra B commits ─────────────────────────
    // A commits `c`, pushes; B fast-forwards its main to c' (no native B
    // commits and no merge); sync back. We expect origin/shadow/{pair}/main
    // to advance to A's original `c` — even though there are no "new" commits
    // to replay from B's side.

    // Merge phase-1 shadow (with the replayed merge) into A/main so A's
    // working branch fully reflects B's state before we continue.
    mergeShadow(env);

    // 8. A commits `c` locally
    commitOnLocal(env, { "phase2.ts": "A phase-2 work\n" }, "c: phase 2 A commit");
    const hashC = git("rev-parse HEAD", env.localRepo);

    // 9. Push A → B (c' lands on team shadow with trailer)
    const r4 = runPush(env);
    assertEqual(r4.status, 0, "[phase 2] push A→B should succeed");

    // 10. On B: fast-forward B/main to c' (no native B commits, no merge commit)
    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge --ff-only origin/${shadowBranch}`, env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // 11. Pull B → A. No new commits from B, but echo mapping must still
    //     advance the shadow branch on origin to A's original c.
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, "[phase 2] pull B→A should succeed");

    // 12. Verify: origin/shadow/{pair}/main tip is literally hashC (A's own
    //     commit — same SHA, not a re-replay).
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTip2 = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    assertEqual(
      shadowTip2,
      hashC,
      "[phase 2] shadow branch tip should be A's original `c` commit (echo mapped to original)",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-echo-mapping");
}
