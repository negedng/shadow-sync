/**
 * Dry-run test for shadow-sync.
 *
 *   A. dry-run pushes nothing — a `--dry-run` pull reports what it *would*
 *      push but leaves origin untouched; a follow-up real pull then creates
 *      the shadow branch, proving dry-run was the only thing suppressing it.
 *   B. dry-run skips tag sync — no tag is propagated to origin under dry-run.
 */
import { execSync } from "child_process";
import {
  createTestEnv, commitOnRemote,
  runCiSync, getShadowLog, readShadowFile,
  setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── A. dry-run pushes nothing, real run does ──────────────────────────────
function runDryRunNoPush(): void {
  const env = createTestEnv("dry-run", "frontend", "shadow", "src");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");

    // Dry run: should succeed, report intent, but create no shadow branch.
    const dry = runCiSync(env, { dryRun: true });
    assertEqual(dry.status, 0, "[dry-run] dry run should exit 0");
    assertIncludes(dry.stdout, "[DRY RUN]", "[dry-run] output should be marked as dry run");
    assertIncludes(dry.stdout, "would push", "[dry-run] should report the push it would make");
    assertIncludes(dry.stdout, "Skipping tag sync", "[dry-run] should announce skipped tag sync");

    assertEqual(getShadowLog(env), "", "[dry-run] no shadow branch should exist after dry run");
    assertEqual(readShadowFile(env, "base.txt"), null, "[dry-run] file must not reach the shadow branch");

    // Real run over the same state: shadow branch now appears.
    const real = runCiSync(env);
    assertEqual(real.status, 0, "[dry-run] real pull should succeed");
    assertEqual(readShadowFile(env, "base.txt"), "base\n",
      "[dry-run] real pull should create the shadow branch dry-run only previewed");
  } finally {
    env.cleanup();
  }
}

// ── B. dry-run skips tag sync ─────────────────────────────────────────────
function runDryRunSkipsTags(): void {
  const env = createTestEnv("dry-run-tags", "frontend", "shadow", "src");
  try {
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    git('tag v1.0.0', env.remoteWorking);
    git('push origin v1.0.0', env.remoteWorking);

    const dry = runCiSync(env, { dryRun: true });
    assertEqual(dry.status, 0, "[dry-run-tags] dry run should exit 0");

    // No tag should have been pushed to origin (the shadow-branch target).
    const originTags = git("ls-remote --tags origin", env.localRepo);
    assertEqual(originTags, "", "[dry-run-tags] no tag should be propagated to origin under dry run");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  // Not a filter test — wildcard.
  setTestBranchAllowlist({ origin: ["**"], team: ["**"] });
  try {
    runDryRunNoPush();
    runDryRunSkipsTags();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-dry-run");
}
