/**
 * Per-endpoint labels. Two sub-tests:
 *
 *   A. namespaces — two pairs on a shared target get distinct label
 *      namespaces (`b-<sub>/<branch>`), both excluded from branch listings;
 *      the push direction lands on `a-<sub>/<branch>` on each external remote;
 *      a settled re-sync is a no-op.
 *   B. validation — duplicate labels across pairs and ill-shaped labels are
 *      rejected before any module state changes.
 */
import {
  createTestEnv, addRemote, commitOnRemote, commitOnLocal,
  runCiSync, runPush, mergeShadow, buildPairs,
  readShadowFile, readExternalShadowFile,
  setTestBranchAllowlist,
} from "./harness";
import { applyTestOverrides, listRemoteBranches, resolveFromSide } from "../shadow-common";
import { assertEqual } from "./assert";
import { execSync } from "child_process";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── A. two pairs, distinct label namespaces on a shared target ───────────────
function runNamespaces(): void {
  const env = createTestEnv("labels-namespaces", "frontend");
  const backend = addRemote(env, "backend", "backend");

  try {
    commitOnRemote(env, { "app.tsx": "export default () => <div/>;\n" }, "Add frontend app");
    commitOnRemote(env, { "server.ts": "app.listen(3000);\n" }, "Add backend server", backend);

    assertEqual(runCiSync(env).status, 0, "[namespaces] ci-sync should succeed");
    assertEqual(readShadowFile(env, "app.tsx"), "export default () => <div/>;\n", "[namespaces] frontend file on b-frontend/main");
    assertEqual(readShadowFile(env, "server.ts", backend), "app.listen(3000);\n", "[namespaces] backend file on b-backend/main");
    assertEqual(readShadowFile(env, "server.ts"), null, "[namespaces] backend file NOT on b-frontend/main");

    // Every endpoint label is excluded from the shared target's branch listing —
    // shadow refs must never look like syncable branches.
    git("fetch origin", env.localRepo);
    applyTestOverrides({ repoRoot: env.localRepo, pairs: buildPairs(env) });
    assertEqual(listRemoteBranches("origin").join(","), "main", "[namespaces] label namespaces excluded from branch listing");

    // Round trip: merge shadows, push local edits out to a-<sub>/main, re-sync no-op.
    mergeShadow(env);
    mergeShadow(env, backend);
    commitOnLocal(env, { "new.tsx": "// frontend code\n" }, "Add frontend file");
    commitOnLocal(env, { "new.ts": "// backend code\n" }, "Add backend file", backend);

    assertEqual(runPush(env).status, 0, "[namespaces] frontend push should succeed");
    assertEqual(runPush(env, undefined, [], backend).status, 0, "[namespaces] backend push should succeed");
    assertEqual(readExternalShadowFile(env, "new.tsx"), "// frontend code\n", "[namespaces] frontend file on a-frontend/main");
    assertEqual(readExternalShadowFile(env, "new.ts", backend), "// backend code\n", "[namespaces] backend file on a-backend/main");

    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "[namespaces] re-sync should succeed");
    assertEqual(r2.stdout.includes("up to date"), true, "[namespaces] re-sync reports up-to-date");
  } finally {
    env.cleanup();
  }
}

// ── B. validation: duplicate / ill-shaped labels rejected before state change ─
function runValidation(repoRoot: string): void {
  const pairAt = (name: string, aLabel: string, bLabel: string) => ({
    name,
    a: { remote: "origin", url: "unused", label: aLabel },
    b: { remote: name, url: "unused", label: bLabel },
    mappings: [{ a: name, b: "" }],
  });

  const expectReject = (pairs: any[], label: string) => {
    let threw = false;
    try {
      applyTestOverrides({ repoRoot, pairs });
    } catch {
      threw = true;
    }
    assertEqual(threw, true, `[validation] ${label} must be rejected`);
  };

  expectReject([pairAt("be", "a-be", "dup"), pairAt("fe", "a-fe", "dup")], "duplicate label across pairs");
  expectReject([pairAt("be", "shared", "b-be"), pairAt("fe", "shared", "b-fe")], "duplicate a-side label");
  expectReject([pairAt("be", "a-be", "")], "empty label");
  expectReject([pairAt("be", "a-be", "-bad")], "leading hyphen");
  expectReject([pairAt("be", "a-be", "b/be")], "slash in label");
  expectReject([pairAt("be", "a-be", "b..be")], "dot-dot in label");
}

// ── C. side aliases: --from resolves names to a/b ────────────────────────────
function runSideAliases(repoRoot: string): void {
  const pair = {
    name: "be",
    a: { remote: "origin", url: "unused", label: "a-be" },
    b: { remote: "ext", url: "unused", label: "b-be" },
    mappings: [{ a: "be", b: "" }],
  };

  applyTestOverrides({ repoRoot, pairs: [pair], sides: { a: "mono", b: "ext" } });
  assertEqual(resolveFromSide("mono"), "a", "[aliases] 'mono' resolves to a");
  assertEqual(resolveFromSide("ext"), "b", "[aliases] 'ext' resolves to b");
  assertEqual(resolveFromSide("a"), "a", "[aliases] literal 'a' still works");
  assertEqual(resolveFromSide("b"), "b", "[aliases] literal 'b' still works");
  assertEqual(resolveFromSide(undefined), "b", "[aliases] default is b");

  let threw = false;
  try { resolveFromSide("nope"); } catch { threw = true; }
  assertEqual(threw, true, "[aliases] unknown --from value is rejected");

  // Without aliases configured, only a/b are accepted.
  applyTestOverrides({ repoRoot, pairs: [pair], sides: null });
  let threw2 = false;
  try { resolveFromSide("mono"); } catch { threw2 = true; }
  assertEqual(threw2, true, "[aliases] alias rejected once sides cleared");

  // Invalid side configs are rejected.
  const expectBadSides = (sides: any, label: string) => {
    let t = false;
    try { applyTestOverrides({ repoRoot, pairs: [pair], sides }); } catch { t = true; }
    assertEqual(t, true, `[aliases] ${label} must be rejected`);
  };
  expectBadSides({ a: "x", b: "x" }, "duplicate side aliases");
  expectBadSides({ a: "a", b: "ext" }, "alias shadowing literal 'a'");
  expectBadSides({ a: "mono", b: "" }, "empty side alias");
}

export default function run(): void {
  setTestBranchAllowlist({ origin: ["main"], team: ["main"], backend: ["main"] });
  try {
    runNamespaces();
    // Pairs are validated before repoRoot is touched, so any path works here.
    runValidation(process.cwd());
    runSideAliases(process.cwd());
  } finally {
    setTestBranchAllowlist();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-labels");
}
