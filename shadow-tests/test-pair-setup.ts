/**
 * Consolidated pair-setup test. Three sub-tests:
 *
 *   A. multi-repo — two pairs (frontend + backend) sync independently
 *      (formerly test-multi-repo.ts)
 *   B. multi-pair-root-files — root-level files survive a two-pair round-trip
 *      (formerly test-multi-pair-root-files.ts)
 *   C. pull-conflict — git merge detects conflicts on shadow content
 *      (formerly test-pull-conflict.ts)
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  createTestEnv, addRemote, commitOnRemote, commitOnLocal,
  runCiSync, mergeShadow, runPush,
  readShadowFile, readExternalShadowFile, readLocalFile,
  getShadowLogFull, getExternalShadowLogFull,
} from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes, assertExitCode } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gitSafe(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFileText(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
}

// ── A. multi-repo: two pairs sync independently ─────────────────────────────
function runMultiRepo(): void {
  const env1 = createTestEnv("multi-repo-env1", "frontend");
  const backend = addRemote(env1, "backend", "backend");
  try {
    // phase 1: pull from both remotes
    commitOnRemote(env1, { "app.tsx": "export default () => <div/>;\n" }, "Add frontend app");
    commitOnRemote(env1, { "server.ts": "app.listen(3000);\n" }, "Add backend server", backend);

    const r1 = runCiSync(env1);
    assertEqual(r1.status, 0, "[multi-repo phase 1] ci-sync should succeed");
    assertEqual(readShadowFile(env1, "app.tsx"), "export default () => <div/>;\n", "[multi-repo 1] frontend file on frontend shadow");
    assertEqual(readShadowFile(env1, "server.ts", backend), "app.listen(3000);\n", "[multi-repo 1] backend file on backend shadow");
    assertIncludes(getShadowLogFull(env1), "Shadow-replayed-", "[multi-repo 1] replay trailers present");
    assertEqual(readShadowFile(env1, "server.ts"), null, "[multi-repo 1] backend file NOT on frontend shadow");
    assertEqual(readShadowFile(env1, "app.tsx", backend), null, "[multi-repo 1] frontend file NOT on backend shadow");

    // phase 2: push from both subdirs
    mergeShadow(env1);
    mergeShadow(env1, backend);

    commitOnLocal(env1, { "new.tsx": "// frontend code\n" }, "Add frontend file");
    commitOnLocal(env1, { "new.ts": "// backend code\n" }, "Add backend file", backend);

    const r2a = runPush(env1, "Push frontend changes");
    assertEqual(r2a.status, 0, "[multi-repo 2] frontend push should succeed");
    const r2b = runPush(env1, "Push backend changes", [], backend);
    assertEqual(r2b.status, 0, "[multi-repo 2] backend push should succeed");

    assertEqual(readExternalShadowFile(env1, "new.tsx"), "// frontend code\n", "[multi-repo 2] frontend file on frontend external");
    assertEqual(readExternalShadowFile(env1, "new.ts"), null, "[multi-repo 2] backend file NOT on frontend external");
    assertEqual(readExternalShadowFile(env1, "new.ts", backend), "// backend code\n", "[multi-repo 2] backend file on backend external");
    assertEqual(readExternalShadowFile(env1, "new.tsx", backend), null, "[multi-repo 2] frontend file NOT on backend external");

    // phase 3: isolation
    commitOnRemote(env1, { "server.ts": "app.listen(3001);\n" }, "Update backend", backend);
    const r3 = runCiSync(env1);
    assertEqual(r3.status, 0, "[multi-repo 3] ci-sync should succeed");
    assertEqual(readShadowFile(env1, "server.ts", backend), "app.listen(3001);\n", "[multi-repo 3] backend shadow updated");
    assertEqual(readShadowFile(env1, "app.tsx"), "export default () => <div/>;\n", "[multi-repo 3] frontend shadow unchanged");

    const r3b = runCiSync(env1);
    assertEqual(r3b.status, 0, "[multi-repo 3] re-sync should succeed");
    assertIncludes(r3b.stdout, "up to date", "[multi-repo 3] re-sync reports up-to-date");
  } finally {
    env1.cleanup();
  }

  // env2: no-cascade (single remote, trailer direction)
  const env2 = createTestEnv("multi-repo-no-cascade");
  try {
    commitOnRemote(env2, { "feature.ts": "from b\n" }, "Add feature from B");
    const r4a = runCiSync(env2);
    assertEqual(r4a.status, 0, "[multi-repo 4] sync from b should succeed");

    const pullLog = getShadowLogFull(env2);
    assertIncludes(pullLog, `Shadow-replayed-${env2.subdir}-${env2.remoteName}:`, "[multi-repo 4] pull has b's remote trailer");
    assertNotIncludes(pullLog, `Shadow-replayed-${env2.subdir}-origin:`, "[multi-repo 4] pull must NOT have a's trailer (would cascade)");

    mergeShadow(env2);
    commitOnLocal(env2, { "local.ts": "from a\n" }, "Add local from A");
    const r4b = runPush(env2, "Push local changes");
    assertEqual(r4b.status, 0, "[multi-repo 4] sync from a should succeed");

    const pushLog = getExternalShadowLogFull(env2);
    assertIncludes(pushLog, `Shadow-replayed-${env2.subdir}-origin:`, "[multi-repo 4] push has a's remote trailer");
    assertNotIncludes(pushLog, `Shadow-replayed-${env2.subdir}-${env2.remoteName}:`, "[multi-repo 4] push must NOT have b's trailer (would cascade)");
  } finally {
    env2.cleanup();
  }
}

// ── B. multi-pair-root-files: root files survive a two-pair round-trip ──────
function runMultiPairRootFiles(): void {
  const env = createTestEnv("multi-pair-root-files", "frontend");
  const backend = addRemote(env, "backend", "backend");

  try {
    // 1. A commits backend/, frontend/, and a root README.md in ONE commit.
    writeFile(env.localRepo, "backend/server.ts", "app.listen(3000);\n");
    writeFile(env.localRepo, "frontend/app.tsx", "export default () => <div>A</div>;\n");
    writeFile(env.localRepo, "README.md", "README v1 — set by A\n");
    git("add -A", env.localRepo);
    git('commit -m "A: initial content for both pairs + root README"', env.localRepo);
    git("push origin main", env.localRepo);

    const rPushBackend = runPush(env, undefined, [], backend);
    assertEqual(rPushBackend.status, 0, "[root-files] push backend pair should succeed");
    const rPushFrontend = runPush(env);
    assertEqual(rPushFrontend.status, 0, "[root-files] push frontend pair should succeed");

    // backend-repo: merge shadow, confirm isolation, add its own edit
    const backendShadow = `${env.branchPrefix}/${backend.subdir}/main`;
    git(`fetch origin ${backendShadow}`, backend.remoteWorking);
    git(`merge origin/${backendShadow} --no-ff -m "B: merge shadow"`, backend.remoteWorking);

    assertEqual(
      fs.existsSync(path.join(backend.remoteWorking, "app.tsx")),
      false,
      "[root-files] backend-repo must not see frontend/app.tsx",
    );
    assertEqual(
      fs.existsSync(path.join(backend.remoteWorking, "README.md")) &&
        fs.readFileSync(path.join(backend.remoteWorking, "README.md"), "utf8").includes("set by A"),
      false,
      "[root-files] backend-repo must not see A's root README",
    );

    writeFile(backend.remoteWorking, "server.ts", "app.listen(3001); // B's port change\n");
    git("add server.ts", backend.remoteWorking);
    git('commit -m "B: change port"', backend.remoteWorking);
    git("push origin main", backend.remoteWorking);

    // frontend-repo: merge shadow, confirm isolation, add its own edit
    const frontendShadow = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch origin ${frontendShadow}`, env.remoteWorking);
    git(`merge origin/${frontendShadow} --no-ff -m "C: merge shadow"`, env.remoteWorking);

    assertEqual(
      fs.existsSync(path.join(env.remoteWorking, "server.ts")),
      false,
      "[root-files] frontend-repo must not see backend/server.ts",
    );
    assertEqual(
      fs.existsSync(path.join(env.remoteWorking, "README.md")) &&
        fs.readFileSync(path.join(env.remoteWorking, "README.md"), "utf8").includes("set by A"),
      false,
      "[root-files] frontend-repo must not see A's root README",
    );

    writeFile(env.remoteWorking, "app.tsx", "export default () => <div>C edited</div>;\n");
    git("add app.tsx", env.remoteWorking);
    git('commit -m "C: edit app"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // A edits the root README while the remotes were doing their work
    writeFile(env.localRepo, "README.md", "README v2 — A edited post-push\n");
    git("add README.md", env.localRepo);
    git('commit -m "A: bump README to v2"', env.localRepo);
    git("push origin main", env.localRepo);

    const rPullAll = runCiSync(env);
    assertEqual(rPullAll.status, 0, "[root-files] pull back from both pairs should succeed");

    mergeShadow(env);             // frontend
    mergeShadow(env, backend);    // backend

    assertEqual(
      readFileText(env.localRepo, "backend/server.ts"),
      "app.listen(3001); // B's port change\n",
      "[root-files] backend/server.ts should reflect B's edit",
    );
    assertEqual(
      readFileText(env.localRepo, "frontend/app.tsx"),
      "export default () => <div>C edited</div>;\n",
      "[root-files] frontend/app.tsx should reflect C's edit",
    );
    assertEqual(
      readFileText(env.localRepo, "README.md"),
      "README v2 — A edited post-push\n",
      "[root-files] README.md MUST still be v2 — A's root edit survived the round-trip",
    );
  } finally {
    env.cleanup();
  }
}

// ── C. pull-conflict: git merge detects conflicts on shadow content ─────────
function runPullConflict(): void {
  const env = createTestEnv("import-conflict");
  try {
    commitOnRemote(env, { "shared.ts": "line 1\nline 2\nline 3\n" }, "Add shared.ts");
    const r1 = runCiSync(env);
    assertExitCode(r1, 0, "[conflict] ci-sync should succeed");

    mergeShadow(env);

    const outsideFile = path.join(env.localRepo, "root-file.txt");
    fs.writeFileSync(outsideFile, "should not be touched\n");
    git("add root-file.txt", env.localRepo);
    git('commit -m "Add root-file.txt"', env.localRepo);

    commitOnRemote(env, { "shared.ts": "line 1\nexternal change\nline 3\n" }, "External edit");
    const r3 = runCiSync(env);
    assertExitCode(r3, 0, "[conflict] second ci-sync should succeed");

    commitOnLocal(env, { "shared.ts": "line 1\nlocal change\nline 3\n" }, "Local edit");

    git(`fetch origin shadow/${env.subdir}/main`, env.localRepo);
    const mergeResult = gitSafe(
      ["merge", "--no-ff", `origin/shadow/${env.subdir}/main`],
      env.localRepo,
    );
    assertEqual(mergeResult.status !== 0, true, "[conflict] merge should fail with conflict");
    assertIncludes(
      mergeResult.stdout + mergeResult.stderr,
      "shared.ts",
      "[conflict] should report the conflicting file",
    );

    const content = readLocalFile(env, "shared.ts")!;
    assertIncludes(content, "<<<<<<<", "[conflict] should have conflict markers");
    assertIncludes(content, ">>>>>>>", "[conflict] should have conflict markers");

    const outsideContent = fs.readFileSync(outsideFile, "utf8");
    assertEqual(outsideContent, "should not be touched\n", "[conflict] root-file.txt should not be affected");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  runMultiRepo();
  runMultiPairRootFiles();
  runPullConflict();
}

if (require.main === module) {
  run();
  console.log("PASS  test-pair-setup");
}
