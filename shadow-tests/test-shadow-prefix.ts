/**
 * Per-pair shadowPrefix. Three sub-tests:
 *
 *   A. custom-prefix — two pairs with shadowPrefix "sf"/"sb" sync to
 *      `sf/main`/`sb/main` instead of `shadow/<pair>/main`; both pairs'
 *      namespaces are excluded from branch listings on the shared target
 *   B. migration — rename existing shadow refs on every remote, flip the
 *      config, and nothing breaks: no re-replay, dedup intact, incremental
 *      syncs continue on the new names
 *   B2. migration with work in flight — unsynced commits on both sides at
 *      the moment of the rename; the first sync after the flip must load
 *      mappings from the renamed refs and replay exactly the pending delta
 *   C. validation — overlapping/nesting namespaces and bad prefix shapes
 *      are rejected before any module state changes
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  createTestEnv, addRemote, commitOnRemote, commitOnLocal,
  runCiSync, runPush, mergeShadow, buildPairs,
  readShadowFile, readExternalShadowFile, getShadowLogFull,
  setTestBranchAllowlist,
} from "./harness";
import { applyTestOverrides, listRemoteBranches } from "../shadow-common";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function refExistsIn(bareRepo: string, ref: string): boolean {
  const r = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], {
    cwd: bareRepo, encoding: "utf8",
  });
  return r.status === 0;
}

// ── A. custom-prefix: two pairs on sf/ + sb/ ─────────────────────────────────
function runCustomPrefix(): void {
  const env = createTestEnv("custom-prefix", "frontend");
  env.remotes[0].shadowPrefix = "sf";
  const backend = addRemote(env, "backend", "backend");
  backend.shadowPrefix = "sb";

  try {
    commitOnRemote(env, { "app.tsx": "export default () => <div/>;\n" }, "Add frontend app");
    commitOnRemote(env, { "server.ts": "app.listen(3000);\n" }, "Add backend server", backend);

    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[custom-prefix] ci-sync should succeed");
    assertEqual(readShadowFile(env, "app.tsx"), "export default () => <div/>;\n", "[custom-prefix] frontend file on sf/main");
    assertEqual(readShadowFile(env, "server.ts", backend), "app.listen(3000);\n", "[custom-prefix] backend file on sb/main");
    assertEqual(readShadowFile(env, "server.ts"), null, "[custom-prefix] backend file NOT on sf/main");
    assertEqual(refExistsIn(env.originBare, "sf/main"), true, "[custom-prefix] sf/main exists on origin");
    assertEqual(refExistsIn(env.originBare, "shadow/frontend/main"), false, "[custom-prefix] default-scheme ref NOT created");

    // Trailers are keyed by pair NAME, not prefix — the dedup key is untouched.
    assertIncludes(getShadowLogFull(env), "Shadow-replayed-frontend-", "[custom-prefix] trailer still uses pair name");

    // Both pairs' namespaces are excluded from the shared target's branch
    // listing — sf/main and sb/main must never look like syncable branches.
    git("fetch origin", env.localRepo);
    applyTestOverrides({ repoRoot: env.localRepo, pairs: buildPairs(env), shadowBranchPrefix: env.branchPrefix });
    assertEqual(listRemoteBranches("origin").join(","), "main", "[custom-prefix] shadow namespaces excluded from branch listing");

    // Round trip: merge shadows, push local edits out, re-sync is a no-op.
    mergeShadow(env);
    mergeShadow(env, backend);
    commitOnLocal(env, { "new.tsx": "// frontend code\n" }, "Add frontend file");
    commitOnLocal(env, { "new.ts": "// backend code\n" }, "Add backend file", backend);

    assertEqual(runPush(env).status, 0, "[custom-prefix] frontend push should succeed");
    assertEqual(runPush(env, undefined, [], backend).status, 0, "[custom-prefix] backend push should succeed");
    assertEqual(readExternalShadowFile(env, "new.tsx"), "// frontend code\n", "[custom-prefix] frontend file on team sf/main");
    assertEqual(readExternalShadowFile(env, "new.ts", backend), "// backend code\n", "[custom-prefix] backend file on backend sb/main");

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[custom-prefix] re-sync should succeed");
    assertIncludes(r2.stdout, "up to date", "[custom-prefix] re-sync reports up-to-date");

    runValidation(env.localRepo);
  } finally {
    env.cleanup();
  }
}

// ── B. migration: rename refs + flip config = seamless continuation ─────────
function runMigration(): void {
  const env = createTestEnv("prefix-migration", "frontend");
  try {
    // Build history under the default scheme, in both directions so shadow
    // refs exist on origin AND on the external remote.
    commitOnRemote(env, { "file.ts": "v1\n" }, "Add file v1");
    assertEqual(runCiSync(env).status, 0, "[migration] initial ci-sync should succeed");
    mergeShadow(env);
    commitOnLocal(env, { "local.ts": "local v1\n" }, "Add local file");
    assertEqual(runPush(env).status, 0, "[migration] initial push should succeed");

    git("fetch origin", env.localRepo);
    const shaBefore = git("rev-parse origin/shadow/frontend/main", env.localRepo);
    const countBefore = Number(git("rev-list --count origin/shadow/frontend/main", env.localRepo));

    // The migration recipe: rename the shadow ref on EVERY remote that holds
    // one, prune stale tracking refs, then flip the config.
    git("branch -m shadow/frontend/main sf/main", env.originBare);
    git("branch -m shadow/frontend/main sf/main", env.remoteBare);
    git("fetch --prune origin", env.localRepo);
    git("fetch --prune team", env.localRepo);
    env.remotes[0].shadowPrefix = "sf";

    // No new source commits: the renamed ref must be recognized as-is.
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "[migration] post-rename sync should succeed");
    assertIncludes(r1.stdout, "up to date", "[migration] post-rename sync is a no-op");
    git("fetch origin", env.localRepo);
    assertEqual(git("rev-parse origin/sf/main", env.localRepo), shaBefore, "[migration] sf/main tip unchanged — no re-replay");

    // Incremental sync continues on the new name: exactly one new commit.
    commitOnRemote(env, { "file.ts": "v2\n" }, "Update file to v2");
    assertEqual(runCiSync(env).status, 0, "[migration] incremental sync should succeed");
    assertEqual(readShadowFile(env, "file.ts"), "v2\n", "[migration] v2 lands on sf/main");
    git("fetch origin", env.localRepo);
    assertEqual(
      Number(git("rev-list --count origin/sf/main", env.localRepo)), countBefore + 1,
      "[migration] dedup intact — exactly one commit added",
    );

    // Export direction also continues on the new name; old name stays gone.
    mergeShadow(env);
    commitOnLocal(env, { "local.ts": "local v2\n" }, "Update local file");
    assertEqual(runPush(env).status, 0, "[migration] post-rename push should succeed");
    assertEqual(readExternalShadowFile(env, "local.ts"), "local v2\n", "[migration] export lands on team sf/main");
    assertEqual(refExistsIn(env.originBare, "shadow/frontend/main"), false, "[migration] old ref not recreated on origin");
    assertEqual(refExistsIn(env.remoteBare, "shadow/frontend/main"), false, "[migration] old ref not recreated on team");
  } finally {
    env.cleanup();
  }
}

// ── B2. migration with work in flight: pending commits on both sides ────────
function runMigrationInFlight(): void {
  const env = createTestEnv("prefix-migration-inflight", "frontend");
  try {
    // Settle one round in both directions under the default scheme.
    commitOnRemote(env, { "file.ts": "v1\n" }, "Add file v1");
    assertEqual(runCiSync(env).status, 0, "[in-flight] initial ci-sync should succeed");
    mergeShadow(env);
    commitOnLocal(env, { "local.ts": "local v1\n" }, "Add local file");
    assertEqual(runPush(env).status, 0, "[in-flight] initial push should succeed");

    git("fetch origin", env.localRepo);
    git("fetch team", env.localRepo);
    const originCount = Number(git("rev-list --count origin/shadow/frontend/main", env.localRepo));
    const teamCount = Number(git("rev-list --count team/shadow/frontend/main", env.localRepo));

    // Work lands on BOTH sides, then the rename happens with it unsynced.
    commitOnRemote(env, { "file.ts": "v2 pending\n" }, "Update file while migrating");
    commitOnLocal(env, { "local.ts": "local v2 pending\n" }, "Update local while migrating");

    git("branch -m shadow/frontend/main sf/main", env.originBare);
    git("branch -m shadow/frontend/main sf/main", env.remoteBare);
    git("fetch --prune origin", env.localRepo);
    git("fetch --prune team", env.localRepo);
    env.remotes[0].shadowPrefix = "sf";

    // First sync after the flip must find the trailer mappings under the new
    // names and replay ONLY the pending commit in each direction.
    assertEqual(runCiSync(env).status, 0, "[in-flight] import should succeed");
    assertEqual(readShadowFile(env, "file.ts"), "v2 pending\n", "[in-flight] pending remote commit lands on sf/main");
    git("fetch origin", env.localRepo);
    assertEqual(
      Number(git("rev-list --count origin/sf/main", env.localRepo)), originCount + 1,
      "[in-flight] import replayed exactly the pending commit — no re-replay",
    );

    assertEqual(runPush(env).status, 0, "[in-flight] export should succeed");
    assertEqual(readExternalShadowFile(env, "local.ts"), "local v2 pending\n", "[in-flight] pending local commit lands on team sf/main");
    git("fetch team", env.localRepo);
    assertEqual(
      Number(git("rev-list --count team/sf/main", env.localRepo)), teamCount + 1,
      "[in-flight] export replayed exactly the pending commit — no re-replay",
    );
  } finally {
    env.cleanup();
  }
}

// ── C. validation: bad prefixes rejected before state changes ────────────────
function runValidation(repoRoot: string): void {
  const pairAt = (name: string, shadowPrefix?: string) => ({
    name,
    ...(shadowPrefix != null ? { shadowPrefix } : {}),
    a: { remote: "origin", url: "unused" },
    b: { remote: name, url: "unused" },
    mappings: [{ a: name, b: "" }],
  });

  const expectReject = (pairs: any[], label: string) => {
    let threw = false;
    try {
      applyTestOverrides({ repoRoot, pairs, shadowBranchPrefix: "shadow" });
    } catch {
      threw = true;
    }
    assertEqual(threw, true, `[validation] ${label} must be rejected`);
  };

  expectReject([pairAt("be", "sb"), pairAt("fe", "sb")], "duplicate namespaces");
  expectReject([pairAt("be", "sb"), pairAt("fe", "sb/nested")], "nested namespaces");
  expectReject([pairAt("be", "shadow/fe"), pairAt("fe")], "custom prefix shadowing a default namespace");
  expectReject([pairAt("be", "/sb")], "leading slash");
  expectReject([pairAt("be", "sb/")], "trailing slash");
  expectReject([pairAt("be", "")], "empty prefix");
}

export default function run(): void {
  setTestBranchAllowlist({ origin: ["main"], team: ["main"], backend: ["main"] });
  try {
    runCustomPrefix();
    runMigration();
    runMigrationInFlight();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-shadow-prefix");
}
