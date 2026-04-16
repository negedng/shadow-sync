import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Consolidated shadowignore test. Two envs — one for the "clean env"
 * phases (basic, deep-glob, midhistory), one for the "never in tree"
 * audit which walks ALL commits and must start with a clean history.
 *
 *   env1:
 *     1. basic — simple pattern excludes a file from shadow
 *     2. deep-glob — `**\/FILE.md` excludes at every depth
 *     3. midhistory — adding .shadowignore mid-history filters from then on
 *
 *   env2:
 *     4. never-in-tree — ignored file appears in NO commit tree on shadow,
 *        even after subsequent unrelated commits
 */
export default function run() {
  // ── env1: three ignore-behavior phases ──────────────────────────────
  const env1 = createTestEnv("push-ignore-behavior");
  try {
    commitOnRemote(env1, { "base.txt": "base\n" }, "Add base");
    const b = runCiSync(env1);
    assertEqual(b.status, 0, "[bootstrap] pull should succeed");
    mergeShadow(env1);

    // ── phase 1: basic ignore ──────────────────────────────────────────
    commitOnLocal(env1, {
      ".shadowignore": "*.local\nsecrets/\n",
      "app.ts": "export const app = true;\n",
      "config.local": "secret stuff\n",
    }, "Add app, config, and .shadowignore");
    const r1 = runPush(env1, "Push with shadowignore");
    assertEqual(r1.status, 0, "[phase 1: basic] push should succeed");
    assertEqual(readExternalShadowFile(env1, "app.ts"), "export const app = true;\n", "[phase 1] app.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "config.local"), null, "[phase 1] config.local NOT on shadow");

    // ── phase 2: deep-glob `**/CLAUDE.md` ──────────────────────────────
    commitOnLocal(env1, {
      ".shadowignore": "**/CLAUDE.md\n",
      "deep-app.ts": "export const deepApp = true;\n",
      "CLAUDE.md": "# root claude\n",
      "src/CLAUDE.md": "# nested claude\n",
      "src/deep/CLAUDE.md": "# deeply nested claude\n",
      "src/deep/real.ts": "export const real = 1;\n",
    }, "Add files with CLAUDE.md at multiple depths");
    const r2 = runPush(env1, "Push with deep shadowignore");
    assertEqual(r2.status, 0, "[phase 2: deep-glob] push should succeed");
    assertEqual(readExternalShadowFile(env1, "deep-app.ts"), "export const deepApp = true;\n", "[phase 2] deep-app.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "src/deep/real.ts"), "export const real = 1;\n", "[phase 2] real.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "CLAUDE.md"), null, "[phase 2] root CLAUDE.md NOT on shadow");
    assertEqual(readExternalShadowFile(env1, "src/CLAUDE.md"), null, "[phase 2] nested CLAUDE.md NOT on shadow");
    assertEqual(readExternalShadowFile(env1, "src/deep/CLAUDE.md"), null, "[phase 2] deeply nested CLAUDE.md NOT on shadow");

    // ── phase 3: midhistory — ignore appears partway through ────────────
    // To exercise "added mid-history", we use a file path not touched earlier.
    // First push: two files, no ignore for THIS path; both arrive.
    commitOnLocal(env1, {
      "visible.ts": "should sync\n",
      "secret.mid": "should not sync later\n",
    }, "Add visible.ts and secret.mid (pre-ignore)");
    const r3a = runPush(env1);
    assertEqual(r3a.status, 0, "[phase 3: midhistory] first push should succeed");
    assertEqual(readExternalShadowFile(env1, "visible.ts"), "should sync\n", "[phase 3] visible.ts on shadow");
    assertEqual(readExternalShadowFile(env1, "secret.mid"), "should not sync later\n", "[phase 3] secret.mid initially on shadow");

    // Now add pattern for *.mid AND attempt to update secret.mid — the update
    // must be filtered; another.ts is a normal visible update.
    commitOnLocal(env1, {
      ".shadowignore": "**/*.mid\n**/CLAUDE.md\n",
      "secret.mid": "updated secret\n",
      "another.ts": "also visible\n",
    }, "Add .shadowignore pattern for *.mid + updates");
    const r3b = runPush(env1);
    assertEqual(r3b.status, 0, "[phase 3] push after adding pattern should succeed");
    assertEqual(readExternalShadowFile(env1, "another.ts"), "also visible\n", "[phase 3] another.ts on shadow");
    assertEqual(
      readExternalShadowFile(env1, "secret.mid"),
      "should not sync later\n",
      "[phase 3] secret.mid update blocked by shadowignore",
    );
  } finally {
    env1.cleanup();
  }

  // ── env2: never-in-tree audit ───────────────────────────────────────
  const env2 = createTestEnv("push-ignore-never-in-tree");
  try {
    // Commit .shadowignore alongside source files
    commitOnLocal(env2, {
      ".shadowignore": "secret.env\n",
      "app.ts": "export const app = true;\n",
      "secret.env": "API_KEY=supersecret\n",
    }, "Add app.ts, secret.env, and .shadowignore");
    const r4a = runPush(env2, "First export");
    assertEqual(r4a.status, 0, "[phase 4: never-in-tree] first push should succeed");
    assertEqual(readExternalShadowFile(env2, "secret.env"), null, "[phase 4] secret.env NOT on shadow (HEAD tree)");
    assertEqual(readExternalShadowFile(env2, "app.ts"), "export const app = true;\n", "[phase 4] app.ts on shadow");

    // Multiple commits to verify walk across history
    commitOnLocal(env2, { "utils.ts": "export const util = true;\n" }, "Add utils.ts");
    const r4b = runPush(env2, "Second export");
    assertEqual(r4b.status, 0, "[phase 4] second push should succeed");

    // Walk ALL commits on shadow branch — secret.env must appear in no tree
    git(`fetch ${env2.remoteName} shadow/${env2.subdir}/main`, env2.localRepo);
    const commits = git(`log ${env2.remoteName}/shadow/${env2.subdir}/main --format=%H`, env2.localRepo)
      .split("\n").filter(Boolean);
    for (const hash of commits) {
      const tree = git(`ls-tree -r --name-only ${hash}`, env2.localRepo);
      const files = tree.split("\n").filter(Boolean);
      const hasSecret = files.some(f => f.endsWith("secret.env"));
      assertEqual(hasSecret, false, `[phase 4] secret.env in tree of ${hash.slice(0, 8)}`);
    }
  } finally {
    env2.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-shadowignore");
}
