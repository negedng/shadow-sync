// Target-side .shadowignore (the union half of the source/target ignore rule).
// On --from b (import) the engine reads the TARGET's .shadowignore from the base
// tree it builds on and unions it with the source patterns: a path is dropped if
// EITHER side ignores it. The pattern lives at the mono ROOT, so it's written in
// TARGET space — the b-side root maps under frontend/, hence the frontend/ prefix.
//
// It's amended into the INIT commit on purpose: a source root anchors to the
// target's init commit (resolveHaltAwareParents), so the shadow branch is rooted
// there and every parentTree carries the init's .shadowignore. This mirrors the
// real "amend .shadowignore into the monorepo init" workflow.
import { execSync } from "child_process";
import * as fs from "fs";
import { createTestEnv, setTestBranchAllowlist, commitOnRemote, runCiSync, readShadowFile } from "./harness";
import { compileShadowIgnoreLine, pathIgnored, computeAutoIgnorePatterns, IgnoreRule } from "../shadow-common";
import { assertEqual } from "./assert";

// ── Unit: the gitignore-faithful .shadowignore rule engine ──────────────────
// negation (re-include) + the "can't re-include under an excluded dir" rule,
// dir-only matching, nested-file confinement, ancestor-file rebasing, and the
// `?` / `[...]` glob syntax. Pure (no git), so it runs first and fails fast.
{
  // Compile `[line, ignoreDir]` pairs (in `sourceDir` space) into an ordered
  // rule list, dropping any that don't apply to the mapping.
  const rules = (sourceDir: string, lines: Array<[string, string]>): IgnoreRule[] =>
    lines.map(([line, dir]) => compileShadowIgnoreLine(line, dir, sourceDir))
      .filter((r): r is IgnoreRule => r !== null);
  const check = (rs: IgnoreRule[], path: string, expected: boolean, label: string) =>
    assertEqual(pathIgnored(rs, path), expected, `${label}: "${path}"`);

  // 1. Negation re-includes when no parent is excluded.
  const neg = rules("", [["*.log", ""], ["!keep.log", ""]]);
  check(neg, "a.log", true, "negation: plain match still ignored");
  check(neg, "keep.log", false, "negation: re-include wins (last match)");
  check(neg, "logs/a.log", true, "negation: *.log matches at any depth");

  // 2. Cannot re-include a file under an excluded directory.
  const par = rules("", [["build/", ""], ["!build/keep.txt", ""]]);
  check(par, "build/keep.txt", true, "ignored-parent: re-include is powerless");
  check(par, "src/main.ts", false, "ignored-parent: unrelated file kept");

  // 3. Dir-only (`/`) matches directories, not a like-named file.
  const dir = rules("", [["cache/", ""]]);
  check(dir, "cache/x", true, "dir-only: file under the dir is ignored");
  check(dir, "cache", false, "dir-only: a file named `cache` is NOT ignored");

  // 4. Anchoring: leading `/` pins to the file's dir; bare name matches any depth.
  const anc = rules("", [["/root.txt", ""], ["any.txt", ""]]);
  check(anc, "root.txt", true, "anchored: matches at root");
  check(anc, "sub/root.txt", false, "anchored: does NOT match deeper");
  check(anc, "sub/any.txt", true, "bare: matches at any depth");

  // 5. `?` is exactly one non-slash char.
  const q = rules("", [["a?c", ""]]);
  check(q, "abc", true, "?: matches one char");
  check(q, "ac", false, "?: requires a char");
  check(q, "a/c", false, "?: does not cross `/`");

  // 6. `[...]` character classes, including negated classes.
  const cls = rules("", [["*.[oa]", ""], ["x.[!z]", ""]]);
  check(cls, "f.o", true, "[oa]: matches o");
  check(cls, "f.a", true, "[oa]: matches a");
  check(cls, "f.c", false, "[oa]: rejects others");
  check(cls, "x.q", true, "[!z]: negated class matches non-z");
  check(cls, "x.z", false, "[!z]: negated class rejects z");

  // 7. Nested file: patterns confined to the file's own subtree.
  const nest = rules("backend", [["secret.ts", "backend/sub"]]);
  check(nest, "sub/secret.ts", true, "nested: matches directly under the file's dir");
  check(nest, "sub/deep/secret.ts", true, "nested: bare name matches any depth below it");
  check(nest, "secret.ts", false, "nested: does NOT leak to the mapping root");
  check(nest, "other/secret.ts", false, "nested: does NOT leak to a sibling subtree");

  // 8. Ancestor file: an anchored pattern rebases down into the mapping space.
  const above = rules("backend", [["/backend/skip/", ""]]);
  check(above, "skip/x.ts", true, "ancestor: rebased dir is ignored inside the mapping");
  check(above, "other/x.ts", false, "ancestor: unrelated path kept");

  // 9. Hard rules (self-strip) win even against a user `!` re-include.
  const self: IgnoreRule = { regex: /^(?:.*\/)?\.shadowignore$/, negated: false, dirOnly: false };
  const hard = [...rules("", [["!.shadowignore", ""]]), self];
  check(hard, ".shadowignore", true, "precedence: appended hard rule overrides user `!`");
  check(hard, "a/.shadowignore", true, "precedence: hard rule matches nested .shadowignore");

  // 10. Contract lock: auto-ignore is STRUCTURAL — computed by
  //     computeAutoIgnorePatterns from the mapping topology, NOT folded into the
  //     diff-overlay rule set (readShadowIgnorePatterns no longer accepts it; the
  //     overlay relies on owner-routing). It is applied only in spliceMappings,
  //     which the round-trip assertion in test-autoignore-nested-mapping covers.
  //     Here we pin that the structural strip still exists for nested mappings.
  const auto = computeAutoIgnorePatterns({
    mappings: [{ a: "leaf", b: "" }, { a: "common", b: "src/common" }],
  } as any);
  check(auto[0].b, "src/common/util.ts", true, "auto-ignore: parent mapping strips nested sibling subtree");
  check(auto[0].b, "other/util.ts", false, "auto-ignore: parent mapping keeps its own content");
  assertEqual(auto[1].b.length, 0, "auto-ignore: the nested (leaf) mapping has no sibling-strip rules");

  console.log("PASS — .shadowignore rule engine (unit): negation, ignored-parent, dir-only, nesting, globs, auto-ignore.");
}

const env = createTestEnv("target-shadowignore", "frontend");
setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

const g = (c: string) => execSync(`git ${c}`, { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// Amend the mono INIT commit (currently HEAD) to carry the target .shadowignore.
fs.writeFileSync(`${env.localRepo}/.shadowignore`, "frontend/skip-me/\n");
g("add .shadowignore");
g("commit --amend --no-edit");
g(`push -f origin ${env.mainBranch}`);

// External dev adds a kept file and a file under the ignored path in one commit.
commitOnRemote(env, {
  "keep.txt": "keep me\n",
  "skip-me/secret.txt": "1.2GB blob stand-in\n",
}, "add keep + skip-me");

const r = runCiSync(env);
assertEqual(r.status, 0, "import --from b should succeed");

assertEqual(readShadowFile(env, "keep.txt"), "keep me\n",
  "non-ignored file syncs to the shadow branch");
assertEqual(readShadowFile(env, "skip-me/secret.txt"), null,
  "target-side .shadowignore drops the incoming ignored-path file on import");

env.cleanup();
console.log("PASS — target .shadowignore drops incoming paths on --from b (union with source).");

// ── Precedence is by depth, not `git ls-tree` emit order ────────────────────
// git: a deeper .shadowignore overrides a shallower one (realized as last-match-
// wins in matchState). ls-tree emits tree order, which is depth order EXCEPT for
// a sibling dir whose name sorts before "." (leading char < 0x2E: "!", "#", "-"):
// it is recursed into first, so its deeper file is emitted BEFORE the shallower
// parent's, inverting precedence. readShadowIgnoreFilePatterns sorts by depth to
// defend against this. Repro on the source/b-side root mapping, where neither
// conflicting file is the mapping-root file the ancestor probe force-orders first:
//   sub/.shadowignore        → *.secret      (depth 1, ignore all)
//   sub/!deep/.shadowignore  → !keep.secret  (depth 2, re-include; "!deep" < ".")
{
  const env2 = createTestEnv("shadowignore-depth-order", "frontend");
  setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

  fs.mkdirSync(`${env2.remoteWorking}/sub/!deep`, { recursive: true });
  commitOnRemote(env2, {
    "sub/.shadowignore": "*.secret\n",
    "sub/!deep/.shadowignore": "!keep.secret\n",
    "sub/!deep/keep.secret": "kept by the deeper re-include\n",
    "sub/!deep/drop.secret": "no re-include — stays ignored\n",
    "sub/top.secret": "ignored by the shallow rule\n",
  }, "nested .shadowignore stack with a before-dot sibling dir");

  assertEqual(runCiSync(env2).status, 0, "import --from b should succeed");

  // Bug-catcher: deepest rule re-includes, so git (and we) keep the file.
  // Pre-fix this was null — the shallow *.secret won last.
  assertEqual(readShadowFile(env2, "sub/!deep/keep.secret"), "kept by the deeper re-include\n",
    "deepest .shadowignore wins: re-included file is synced");
  // Controls — the deeper file re-includes only keep.secret; the rest stay dropped.
  assertEqual(readShadowFile(env2, "sub/!deep/drop.secret"), null,
    "control: a sibling the deeper rule does NOT re-include stays ignored");
  assertEqual(readShadowFile(env2, "sub/top.secret"), null,
    "control: the shallow rule still ignores files at its own level");

  env2.cleanup();
  console.log("PASS — .shadowignore precedence sorts by depth, not ls-tree emit order.");
}
