/**
 * End-to-end test for SyncPair.mappings — one pair carrying multiple
 * source→target folder mappings. Replaces what used to require multiple
 * dedicated pairs (e.g. parent + nested-common in sht6).
 *
 * Topology:
 *   monorepo ↔ leaf
 *     mapping 0:  mono/appA   ↔  leaf/src/app
 *     mapping 1:  mono/shared ↔  leaf/src/shared
 *
 * Scenarios:
 *   1. Cross-cutting commit on mono touches BOTH appA/ AND shared/ in a
 *      single commit. --from a produces ONE synthetic on leaf's shadow ref
 *      that carries both subtrees, routed to their respective target dirs.
 *   2. Operator merge of the shadow ref into leaf main lands both slices
 *      at their canonical leaf paths.
 *   3. Leaf-side edit in src/shared/ rides --from b back into mono via
 *      mapping 1 (longest-prefix routing strips the src/shared/ prefix).
 *   4. .shadowignore at the mono root cascades into both mappings
 *      (gitignore-style); a per-mapping-dir .shadowignore adds anchored
 *      rules scoped to that mapping. The .shadowignore files themselves
 *      are stripped from the synced tree.
 *
 * Run: npx tsx shadow-tests/test-multi-mapping.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, compileIgnorePattern, setBranchFiltersForTesting } from "../shadow-common";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function writeRepoConfig(workDir: string, identity: { email: string; name: string }) {
  fs.appendFileSync(path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${identity.email}\n\tname = ${identity.name}\n[core]\n\tautocrlf = false\n`);
}
interface Repo { bare: string; working: string; }
function createRepo(tmpDir: string, name: string, identity: { email: string; name: string }): Repo {
  const bare = path.join(tmpDir, `${name}-bare`).replace(/\\/g, "/");
  const working = path.join(tmpDir, `${name}-working`).replace(/\\/g, "/");
  fs.mkdirSync(bare);
  git("init --bare --initial-branch=main", bare);
  execSync(`git clone "${bare}" "${working}"`, { encoding: "utf8", stdio: "pipe" });
  writeRepoConfig(working, identity);
  git("symbolic-ref HEAD refs/heads/main", working);
  return { bare, working };
}
function commitFiles(repo: Repo, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}
function banner(s: string) { console.log("\n" + "─".repeat(70) + "\n  " + s + "\n" + "─".repeat(70)); }

function readPath(bare: string, ref: string, p: string): string | null {
  try {
    return execSync(`git show ${ref}:${p}`, { cwd: bare, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-mapping-"));
  console.log(`[tmp] ${tmpDir}`);

  try {
    const leaf = createRepo(tmpDir, "leaf", { email: "lea@example.com",  name: "Lea"  });
    const mono = createRepo(tmpDir, "mono", { email: "mira@example.com", name: "Mira" });
    git(`remote add leaf "${leaf.bare}"`, mono.working);

    // Bootstrap: mono has both subtrees; leaf starts empty (bare commit only).
    commitFiles(leaf, { "README.md": "leaf\n" }, "Lc0");
    git("push origin main", leaf.working);
    commitFiles(mono, {
      "README.md":         "monorepo\n",
      "appA/index.ts":     "app v1\n",
      "shared/util.ts":    "util v1\n",
    }, "Mc0");
    git("push origin main", mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        {
          name: "leaf",
          a: { remote: "origin", url: mono.bare },
          b: { remote: "leaf",   url: leaf.bare },
          mappings: [
            { a: "appA",   b: "src/app" },
            { a: "shared", b: "src/shared" },
          ],
        },
      ],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("**")]],
      ["leaf",   [compileIgnorePattern("**")]],
    ]));

    // ── 1. --from a: one synthetic carries both subtrees ────────────────────
    banner("1. Cross-cutting --from a — one synthetic, two subtrees");
    let r = await runSync({ from: "a" });
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      throw new Error("--from a bootstrap failed");
    }

    git("fetch origin", leaf.working);
    const appOnShadow    = readPath(leaf.bare, "refs/heads/shadow/leaf/main", "src/app/index.ts");
    const sharedOnShadow = readPath(leaf.bare, "refs/heads/shadow/leaf/main", "src/shared/util.ts");
    if (appOnShadow !== "app v1\n") throw new Error(`src/app/index.ts mismatch on shadow: ${JSON.stringify(appOnShadow)}`);
    if (sharedOnShadow !== "util v1\n") throw new Error(`src/shared/util.ts mismatch on shadow: ${JSON.stringify(sharedOnShadow)}`);
    console.log(`  ✓ both mappings produced one synthetic with composite tree on shadow/leaf/main`);

    // ── 2. Operator merges shadow ref into leaf main ─────────────────────────
    banner("2. Leaf merges shadow ref — both slices land at canonical leaf paths");
    git("fetch origin", leaf.working);
    git("checkout main", leaf.working);
    git(`merge --no-ff origin/shadow/leaf/main -m "merge from shadow"`, leaf.working);
    git("push origin main", leaf.working);

    if (readPath(leaf.bare, "main", "src/app/index.ts") !== "app v1\n") throw new Error("leaf main missing src/app/index.ts");
    if (readPath(leaf.bare, "main", "src/shared/util.ts") !== "util v1\n") throw new Error("leaf main missing src/shared/util.ts");
    console.log(`  ✓ leaf main carries src/app/index.ts and src/shared/util.ts after merge`);

    // ── 3. Leaf-side edit in src/shared/ rides --from b back via mapping 1 ──
    banner("3. Leaf edit in src/shared/ — longest-prefix routes through mapping 1");
    commitFiles(leaf, { "src/shared/util.ts": "util v2 leaf-edit\n" }, "Lc1");
    git("push origin main", leaf.working);

    r = await runSync({ from: "b" });
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      throw new Error("--from b after leaf edit failed");
    }

    git("fetch origin", mono.working);
    const sharedOnMonoShadow = readPath(mono.bare, "refs/heads/shadow/leaf/main", "shared/util.ts");
    const appOnMonoShadow    = readPath(mono.bare, "refs/heads/shadow/leaf/main", "appA/index.ts");
    if (sharedOnMonoShadow !== "util v2 leaf-edit\n") {
      throw new Error(`leaf edit did NOT reach mono via mapping 1; shared/util.ts on shadow = ${JSON.stringify(sharedOnMonoShadow)}`);
    }
    if (appOnMonoShadow !== "app v1\n") {
      throw new Error(`appA slice should be untouched on shadow; got ${JSON.stringify(appOnMonoShadow)}`);
    }
    console.log(`  ✓ src/shared edit routed to mono shared/ via mapping 1; appA/ unchanged`);

    // ── 4. Multi-level .shadowignore: root + per-mapping-dir ────────────────
    banner("4. Multi-level .shadowignore — root cascades, per-dir is anchored");
    // Operator pulls leaf change into mono main so the next --from a starts clean.
    git("checkout main", mono.working);
    git("fetch origin", mono.working);
    git(`merge --no-ff origin/shadow/leaf/main -m "pull leaf edit"`, mono.working);

    // Set up multi-level ignores on mono:
    //   mono/.shadowignore       → *.tmp (basename-anywhere)
    //   mono/appA/.shadowignore  → dist/ (anchored to appA scope)
    fs.writeFileSync(path.join(mono.working, ".shadowignore"), "*.tmp\n");
    fs.writeFileSync(path.join(mono.working, "appA/.shadowignore"), "dist/\n");
    fs.mkdirSync(path.join(mono.working, "appA/dist"), { recursive: true });
    fs.writeFileSync(path.join(mono.working, "appA/dist/bundle.js"), "compiled\n");
    fs.writeFileSync(path.join(mono.working, "appA/scratch.tmp"), "scratch\n");
    fs.writeFileSync(path.join(mono.working, "shared/notes.tmp"), "shared scratch\n");
    fs.writeFileSync(path.join(mono.working, "appA/feature.ts"), "feature\n");
    fs.writeFileSync(path.join(mono.working, "shared/helpers.ts"), "helpers\n");
    git("add -A", mono.working);
    git('commit -m "add ignored + visible files"', mono.working);
    git("push origin main", mono.working);

    r = await runSync({ from: "a" });
    if (r.exitCode !== 0) {
      console.error(r.stdout); console.error(r.stderr);
      throw new Error("--from a after multi-level shadowignore failed");
    }
    git("fetch origin", leaf.working);

    const shouldExist = [
      ["src/app/feature.ts", "feature\n"],
      ["src/shared/helpers.ts", "helpers\n"],
    ];
    const shouldNotExist = [
      // basename-anywhere from mono/.shadowignore
      "src/app/scratch.tmp",
      "src/shared/notes.tmp",
      // anchored from mono/appA/.shadowignore
      "src/app/dist/bundle.js",
      // implicit self-strip
      "src/app/.shadowignore",
      ".shadowignore",
    ];
    for (const [p, want] of shouldExist) {
      const got = readPath(leaf.bare, "refs/heads/shadow/leaf/main", p);
      if (got !== want) throw new Error(`expected ${p} = ${JSON.stringify(want)} on shadow; got ${JSON.stringify(got)}`);
    }
    for (const p of shouldNotExist) {
      const got = readPath(leaf.bare, "refs/heads/shadow/leaf/main", p);
      if (got !== null) throw new Error(`expected ${p} to be ABSENT on shadow; got ${JSON.stringify(got)}`);
    }
    console.log(`  ✓ root *.tmp cascades into both mappings; appA/dist/ blocked; .shadowignore files stripped`);

    console.log("\n  ✓ PASS — multi-mapping pair behaves correctly end-to-end.");
  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error("\n[error]", e.message); process.exit(1); });
