/**
 * Safety-limit tests for shadow-sync.
 *
 *   A. Commit-count gate — a run replaying more than maxCommitsPerSync commits
 *      fails closed naming --allow-many-commits; the flag clears it.
 *   B. Commit-size gate — a commit replaying more than maxCommitBytes of mapped
 *      content fails closed naming --allow-large-commits.
 *   C. Size-gate escape hatches — the flag passes it, and .shadowignore-ing the
 *      oversized path drops it from the replayed byte count so the gate passes
 *      without the flag.
 */
import {
  createTestEnv, commitOnRemote,
  runCiSync, readShadowFile,
  setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

// ── A. commit-count gate ──────────────────────────────────────────────────
function runCountGate(): void {
  const env = createTestEnv("safety-count", "frontend", "shadow", "");
  try {
    commitOnRemote(env, { "a.txt": "a\n" }, "Add a");
    commitOnRemote(env, { "b.txt": "b\n" }, "Add b");
    commitOnRemote(env, { "c.txt": "c\n" }, "Add c");

    // 3 new commits, limit 2 → fail closed.
    const blocked = runCiSync(env, { maxCommitsPerSync: 2 });
    assertEqual(blocked.status, 1, "[count] over-limit sync should fail");
    assertIncludes(blocked.stderr, "exceeds the safety limit of 2",
      "[count] should report the limit it tripped");
    assertIncludes(blocked.stderr, "--allow-many-commits",
      "[count] should name the override flag");
    assertEqual(readShadowFile(env, "c.txt"), null,
      "[count] nothing should be replayed when the gate trips");

    // Same state, override on → replays.
    const allowed = runCiSync(env, { maxCommitsPerSync: 2, allowManyCommits: true });
    assertEqual(allowed.status, 0, "[count] override should clear the gate");
    assertEqual(readShadowFile(env, "c.txt"), "c\n",
      "[count] override should replay all commits");
  } finally {
    env.cleanup();
  }
}

// ── B. commit-size gate ───────────────────────────────────────────────────
function runSizeGate(): void {
  const env = createTestEnv("safety-size", "frontend", "shadow", "");
  try {
    const big = "x".repeat(8192);  // 8 KB blob
    commitOnRemote(env, { "big.bin": big }, "Add big blob");

    const blocked = runCiSync(env, { maxCommitBytes: 4096 });
    assertEqual(blocked.status, 1, "[size] over-limit commit should fail");
    assertIncludes(blocked.stderr, "--allow-large-commits",
      "[size] should name the override flag");
    assertEqual(readShadowFile(env, "big.bin"), null,
      "[size] nothing should be replayed when the gate trips");

    // Override on → replays.
    const allowed = runCiSync(env, { maxCommitBytes: 4096, allowLargeCommits: true });
    assertEqual(allowed.status, 0, "[size] override should clear the gate");
    assertEqual(readShadowFile(env, "big.bin"), big,
      "[size] override should replay the oversized commit");
  } finally {
    env.cleanup();
  }
}

// ── C. .shadowignore drops the oversized blob from the byte count ─────────
function runShadowignoreEscape(): void {
  const env = createTestEnv("safety-size-ignore", "frontend", "shadow", "");
  try {
    const big = "x".repeat(8192);  // 8 KB, would trip the 4 KB limit if counted
    // Load-bearing (small.txt), but big.bin is ignored so it must not count.
    commitOnRemote(env, {
      "big.bin": big,
      "small.txt": "hi\n",
      ".shadowignore": "big.bin\n",
    }, "Add small + ignored big");

    const res = runCiSync(env, { maxCommitBytes: 4096 });
    assertEqual(res.status, 0,
      "[size-ignore] ignored blob must not count toward the size gate");
    assertEqual(readShadowFile(env, "small.txt"), "hi\n",
      "[size-ignore] the non-ignored content should still replay");
    assertEqual(readShadowFile(env, "big.bin"), null,
      "[size-ignore] the ignored blob should not be replayed");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  setTestBranchAllowlist({ origin: ["**"], team: ["**"] });
  try {
    runCountGate();
    runSizeGate();
    runShadowignoreEscape();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-safety-limits");
}
