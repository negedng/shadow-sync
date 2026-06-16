/**
 * test-identity-map.ts — per-remote identity profiles rewrite author/committer
 * at replay time.
 *
 *   1. import (b→a): mapped author rewritten (case-insensitive email match),
 *      unmapped committer passes through
 *   2. import: unmapped identity copied verbatim
 *   3. import: mapped committer rewritten too
 *   4. export (a→b): reverse direction maps the mono identity back out
 *   5. round-trip: merge-and-resync on both sides; neither repo's shadow ever
 *      shows the other side's identity
 *   6. config validation: duplicate email on one remote fails closed
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  buildPairs, commitOnLocal, commitOnRemote, createTestEnv, mergeShadow,
  runCiSync, runPush, setTestBranchAllowlist, shadowBranchOf, TestEnv,
} from "./harness";
import { applyTestOverrides } from "../shadow-common";
import { assertEqual, assertIncludes, assertNotIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** "author <email>|committer <email>|subject" per commit on a shadow ref, newest first.
 *  `from` picks the ref direction: "b" = pull ref on origin, "a" = push ref on team. */
function identityLog(env: TestEnv, remoteName: string, from: "a" | "b" = "b"): string[] {
  const branch = shadowBranchOf(env, undefined, from);
  git(`fetch ${remoteName} ${branch}`, env.localRepo);
  return git(`log ${remoteName}/${branch} --format="%an <%ae>|%cn <%ce>|%s"`, env.localRepo)
    .split("\n").filter(Boolean);
}

function lineFor(lines: string[], subject: string): string {
  const hit = lines.find(l => l.endsWith(`|${subject}`));
  if (!hit) throw new Error(`no commit with subject "${subject}" in:\n${lines.join("\n")}`);
  return hit;
}

export default function run(): void {
  setTestBranchAllowlist({ origin: ["main"], team: ["main"] });
  const env = createTestEnv("identity-map");
  try {
    env.identities = [{
      origin: { name: "Yana Mono", email: "yana@mono.test" },
      team:   { name: "Xav Ext",   email: "xav@ext.test" },
    }];

    // phase 1: mapped author — uppercase email exercises case-insensitive match;
    // committer (Team Member, no profile) passes through.
    fs.writeFileSync(path.join(env.remoteWorking, "a.ts"), "a\n");
    git("add -A", env.remoteWorking);
    git('commit --author="Xav Ext <XAV@ext.test>" -m "Xav feature"', env.remoteWorking);
    git(`push origin ${env.mainBranch}`, env.remoteWorking);
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, `[identity 1] ci-sync: ${r1.stderr.slice(0, 300)}`);
    assertEqual(lineFor(identityLog(env, "origin"), "Xav feature"),
      "Yana Mono <yana@mono.test>|Team Member <team@test.com>|Xav feature",
      "[identity 1] author mapped to mono profile, unmapped committer verbatim");

    // phase 2: unmapped identity passes through
    commitOnRemote(env, { "b.ts": "b\n" }, "Team feature");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, `[identity 2] ci-sync: ${r2.stderr.slice(0, 300)}`);
    assertEqual(lineFor(identityLog(env, "origin"), "Team feature"),
      "Team Member <team@test.com>|Team Member <team@test.com>|Team feature",
      "[identity 2] unmapped identity copied verbatim");

    // phase 3: committer mapped through the same table
    fs.writeFileSync(path.join(env.remoteWorking, "c.ts"), "c\n");
    git("add -A", env.remoteWorking);
    execSync('git commit --author="Xav Ext <xav@ext.test>" -m "Xav both"', {
      cwd: env.remoteWorking, stdio: "pipe",
      env: { ...process.env, GIT_COMMITTER_NAME: "Xav Ext", GIT_COMMITTER_EMAIL: "xav@ext.test" },
    });
    git(`push origin ${env.mainBranch}`, env.remoteWorking);
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, `[identity 3] ci-sync: ${r3.stderr.slice(0, 300)}`);
    assertEqual(lineFor(identityLog(env, "origin"), "Xav both"),
      "Yana Mono <yana@mono.test>|Yana Mono <yana@mono.test>|Xav both",
      "[identity 3] committer mapped too");

    // phase 4: export — mono engineer merges the shadow, Yana commits, the
    // replay on the external shadow carries Xav's identity.
    mergeShadow(env);
    commitOnLocal(env, { "d.ts": "d\n" }, "Yana change");
    git('commit --amend --no-edit --author="Yana Mono <yana@mono.test>"', env.localRepo);
    const r4 = runPush(env);
    assertEqual(r4.status, 0, `[identity 4] push: ${r4.stderr.slice(0, 300)}`);
    assertEqual(lineFor(identityLog(env, "team", "a"), "Yana change"),
      "Xav Ext <xav@ext.test>|Local Dev <local@test.com>|Yana change",
      "[identity 4] export maps mono identity back to external; unmapped committer verbatim");

    // phase 5: round-trip — external merges its shadow into main, resync.
    // Invariant: neither repo's shadow ever shows the other side's identity.
    git("fetch origin", env.remoteWorking);
    git(`merge origin/${shadowBranchOf(env, undefined, "a")} --no-ff -m "Integrate shadow"`, env.remoteWorking);
    git(`push origin ${env.mainBranch}`, env.remoteWorking);
    const r5 = runCiSync(env);
    assertEqual(r5.status, 0, `[identity 5] resync: ${r5.stderr.slice(0, 300)}`);
    assertNotIncludes(identityLog(env, "origin").join("\n"), "xav@ext.test",
      "[identity 5] external identity never appears on mono's shadow");
    assertNotIncludes(identityLog(env, "team", "a").join("\n"), "yana@mono.test",
      "[identity 5] mono identity never appears on the external shadow");
    const r5b = runCiSync(env);
    assertEqual(r5b.status, 0, "[identity 5] re-run succeeds");
    assertIncludes(r5b.stdout, "up to date", "[identity 5] re-run is a no-op");

    // phase 6: duplicate email on one remote is ambiguous in reverse — rejected
    let thrown = "";
    try {
      applyTestOverrides({
        repoRoot: env.localRepo,
        pairs: buildPairs(env),
        identities: [
          { team: { name: "A", email: "dup@ext.test" }, origin: { name: "A2", email: "a@mono.test" } },
          { team: { name: "B", email: "DUP@ext.test" }, origin: { name: "B2", email: "b@mono.test" } },
        ],
      });
    } catch (e: any) {
      thrown = e.message;
    }
    assertIncludes(thrown, "duplicate email", "[identity 6] duplicate email per remote rejected");
  } finally {
    env.cleanup();
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-identity-map");
}
