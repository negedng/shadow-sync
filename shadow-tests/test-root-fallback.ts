/**
 * targetInit-fallback rebuild. When a commit's first parent is unmapped with
 * no echo anchor, the base is targetInit's tree — not the real parent's — so
 * the replay rebuilds the inner wholesale from the source commit instead of
 * applying a first-parent delta. Three sub-tests:
 *
 *   A. tip-only seed — the shadow tip's trailer maps ONLY the source tip
 *      (as a hand-built recovery commit or a tip-only bootstrap would); a
 *      branch forked below the frontier must still replay with full, correct
 *      content (anchored at targetInit)
 *   B. control — identical topology under a normal full bootstrap
 *   C. filter narrowing — a branch whose mapping ref is no longer loaded gets
 *      re-collected and re-replayed (duplication, never a wrong tree)
 */
import * as fs from "fs";
import { execSync } from "child_process";
import {
  createTestEnv, commitOnRemote, runCiSync, setTestBranchAllowlist,
} from "./harness";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function lsShadowFeat(localRepo: string): string {
  git("fetch origin shadow/frontend/feat", localRepo);
  return git("ls-tree -r --name-only origin/shadow/frontend/feat", localRepo);
}

// ── A. tip-only seed: fork below a tip-only mapped frontier ─────────────────
function runTipOnlySeed(): void {
  const env = createTestEnv("root-fallback-tiponly", "frontend");
  try {
    setTestBranchAllowlist({ origin: ["main", "feat"], team: ["main", "feat"] });

    // S1, S2 on team/main — in-scope changes, never synced.
    commitOnRemote(env, { "a.ts": "from S1\n" }, "S1: add a.ts");
    commitOnRemote(env, { "b.ts": "from S2\n" }, "S2: add b.ts");
    git("fetch team", env.localRepo);
    const s2 = git("rev-parse team/main", env.localRepo);

    // Hand-built shadow tip whose trailer maps ONLY S2.
    const monoTree = git('rev-parse "origin/main^{tree}"', env.localRepo);
    const monoTip = git("rev-parse origin/main", env.localRepo);
    const msgFile = `${env.tmpDir}/boot-msg.txt`;
    fs.writeFileSync(msgFile, `tip-only bootstrap\n\nShadow-replayed-frontend-team: ${s2}\n`);
    const boot = git(`commit-tree ${monoTree} -p ${monoTip} -F "${msgFile}"`, env.localRepo);
    git(`push origin ${boot}:refs/heads/shadow/frontend/main`, env.localRepo);

    // feat forks BELOW the mapped frontier (at S1) and adds S3.
    git("checkout -b feat main~1", env.remoteWorking);
    fs.writeFileSync(`${env.remoteWorking}/c.ts`, "from S3\n");
    git("add c.ts", env.remoteWorking);
    git('commit -m "S3: add c.ts"', env.remoteWorking);
    git("push origin feat", env.remoteWorking);

    const r = runCiSync(env);
    assertEqual(r.status, 0, "[tip-only] sync should succeed");

    // S1 is settled via the S2 frontier and unmapped → S3's parent falls back
    // to targetInit; the rebuild must carry S1's content, not just diff(S1→S3).
    const files = lsShadowFeat(env.localRepo);
    assertIncludes(files, "frontend/a.ts", "[tip-only] S1's content present despite unmapped parent");
    assertIncludes(files, "frontend/c.ts", "[tip-only] S3's own content present");
    assertNotIncludes(files, "frontend/b.ts", "[tip-only] S2's content absent (not an ancestor of S3)");

    // The graph anchor is targetInit — the inherent cost of the missing mapping.
    const parents = git("log -1 --format=%P origin/shadow/frontend/feat", env.localRepo);
    const targetInit = git("log --max-parents=0 --format=%H origin/main", env.localRepo);
    assertEqual(parents, targetInit, "[tip-only] replay anchored at targetInit");
  } finally {
    env.cleanup();
  }
}

// ── B. control: same topology, normal full bootstrap ────────────────────────
function runControl(): void {
  const env = createTestEnv("root-fallback-control", "frontend");
  try {
    setTestBranchAllowlist({ origin: ["main", "feat"], team: ["main", "feat"] });

    commitOnRemote(env, { "a.ts": "from S1\n" }, "S1: add a.ts");
    commitOnRemote(env, { "b.ts": "from S2\n" }, "S2: add b.ts");
    assertEqual(runCiSync(env).status, 0, "[control] bootstrap sync should succeed");

    git("checkout -b feat main~1", env.remoteWorking);
    fs.writeFileSync(`${env.remoteWorking}/c.ts`, "from S3\n");
    git("add c.ts", env.remoteWorking);
    git('commit -m "S3: add c.ts"', env.remoteWorking);
    git("push origin feat", env.remoteWorking);

    assertEqual(runCiSync(env).status, 0, "[control] sync should succeed");
    const files = lsShadowFeat(env.localRepo);
    assertIncludes(files, "frontend/a.ts", "[control] a.ts present under full bootstrap");
  } finally {
    env.cleanup();
  }
}

// ── C. filter narrowing: lost mapping self-heals via re-collection ──────────
function runFilterNarrowing(): void {
  const env = createTestEnv("root-fallback-filternarrow", "frontend");
  try {
    setTestBranchAllowlist({ origin: ["main", "rel"], team: ["main", "rel"] });
    commitOnRemote(env, { "base.ts": "S0\n" }, "S0: base");
    git("checkout -b rel", env.remoteWorking);
    fs.writeFileSync(`${env.remoteWorking}/a.ts`, "from S1\n");
    git("add a.ts", env.remoteWorking);
    git('commit -m "S1: add a.ts on rel"', env.remoteWorking);
    git("push origin rel", env.remoteWorking);
    assertEqual(runCiSync(env).status, 0, "[narrow] bootstrap sync (main+rel) should succeed");

    // rel leaves the allowlist; feat forks from rel's tip (S1). S1's mapping
    // lives only on shadow/rel, which is no longer loaded.
    setTestBranchAllowlist({ origin: ["main", "feat"], team: ["main", "feat"] });
    git("checkout -b feat rel", env.remoteWorking);
    fs.writeFileSync(`${env.remoteWorking}/c.ts`, "from S3\n");
    git("add c.ts", env.remoteWorking);
    git('commit -m "S3: add c.ts on feat"', env.remoteWorking);
    git("push origin feat", env.remoteWorking);

    assertEqual(runCiSync(env).status, 0, "[narrow] sync (rel unloaded) should succeed");
    const files = lsShadowFeat(env.localRepo);
    assertIncludes(files, "frontend/a.ts", "[narrow] S1 re-collected and re-replayed — tree correct");
  } finally {
    env.cleanup();
  }
}

export default function run(): void {
  try {
    runTipOnlySeed();
    runControl();
    runFilterNarrowing();
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-root-fallback");
}
