/**
 * Regression test for the intra-pair nested-mapping auto-ignore.
 *
 * A pair with two mappings where one mapping's b-path nests under another's
 * (e.g. primary `{a: backend, b: ""}` plus nested-common `{a: common, b: src/common}`)
 * needs auto-ignore patterns so the primary mapping doesn't also copy content
 * owned by the nested mapping. Without it, a full round-trip (leaf → mono via
 * --from b, integrate, --from a, leaf merges shadow, --from b again) ends up
 * with the common content at BOTH the canonical leaf-nested path
 * (`backend/src/common/util.ts` on mono) AND the longest-prefix-routed root
 * (`common/util.ts`).
 *
 * The bug was originally caught by test-scenario.ts Phase 4. This
 * file isolates the minimal repro so the regression is obvious if the
 * intra-pair auto-ignore is dropped again.
 *
 * History: auto-ignore was originally a multi-pair-same-repo mechanism;
 * commit 9f9f6cf removed it when multi-mapping pairs replaced the 2-pair
 * configs. Commit 0d3c55c reintroduced it under the new intra-pair trigger.
 *
 * Run: npx tsx shadow-tests/test-autoignore-nested-mapping.ts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, compileIgnorePattern, setBranchFiltersForTesting } from "../shadow-common";
import { assertEqual } from "./assert";

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
function listTreePaths(repo: Repo, ref: string): string[] {
  return git(`ls-tree -r --name-only ${ref}`, repo.working).split("\n").filter(Boolean);
}

async function run(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-autoignore-"));

  try {
    const leaf = createRepo(tmpDir, "leaf", { email: "leaf@e.com", name: "Leaf" });
    const mono = createRepo(tmpDir, "mono", { email: "mono@e.com", name: "Mono" });
    git(`remote add leaf "${leaf.bare}"`, mono.working);

    // Leaf bootstraps with content at both the primary-mapping root and the
    // nested common path — the byte-identical content is what the autoignore
    // is meant to prevent from being duplicated on mono.
    commitFiles(leaf, {
      "src/init.txt":        "init\n",
      "src/common/util.ts":  "util v1\n",
    }, "Lc0");
    git("push origin main", leaf.working);

    commitFiles(mono, { "README.md": "# Monorepo\n" }, "Mc0");
    git("push origin main", mono.working);

    // ONE pair, TWO mappings: primary at leaf-root, nested common under src/common.
    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [
        {
          name: "leaf",
          a: { remote: "origin", url: mono.bare },
          b: { remote: "leaf",   url: leaf.bare },
          mappings: [
            { a: "leaf",   b: ""           },
            { a: "common", b: "src/common" },
          ],
        },
      ],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map([
      ["origin", [compileIgnorePattern("main")]],
      ["leaf",   [compileIgnorePattern("main")]],
    ]));

    // ── Bootstrap: leaf → mono ────────────────────────────────────────────
    {
      const r = await runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `bootstrap --from b: ${r.stderr.slice(0, 200)}`);
    }
    git("fetch origin", mono.working);

    // Bootstrap shadow tip must route common/util.ts via the longer mapping —
    // NOT via the primary mapping's canonical leaf path.
    {
      const tree = listTreePaths(mono, "origin/shadow/leaf/main");
      if (tree.includes("leaf/src/common/util.ts")) {
        throw new Error(`bootstrap: leaf/src/common/util.ts must NOT appear (longest-prefix routing). Tree:\n  ${tree.join("\n  ")}`);
      }
      if (!tree.includes("common/util.ts")) {
        throw new Error(`bootstrap: common/util.ts must appear at root. Tree:\n  ${tree.join("\n  ")}`);
      }
    }

    // ── Integrate on mono, add a mono-side commit, push back to leaf ──────
    git("merge --no-ff origin/shadow/leaf/main -m Mc1", mono.working);
    // Mc2 touches the common slice — gives --from a something to replay so
    // the round-trip echo-splice path inside composeMergeBaseTree fires.
    commitFiles(mono, { "common/util.ts": "util v2\n" }, "Mc2");
    git("push origin main", mono.working);
    {
      const r = await runSync({ from: "a" });
      assertEqual(r.exitCode, 0, `--from a: ${r.stderr.slice(0, 200)}`);
    }

    // ── Leaf integrates the shadow back into main, pushes ────────────────
    git("fetch origin", leaf.working);
    const Lc1 = (() => {
      git("merge --no-ff origin/shadow/leaf/main -m Lc1", leaf.working);
      return git("rev-parse HEAD", leaf.working);
    })();
    git("push origin main", leaf.working);

    // ── Round-trip --from b: this is where the bug manifested ────────────
    {
      const r = await runSync({ from: "b" });
      assertEqual(r.exitCode, 0, `round-trip --from b: ${r.stderr.slice(0, 200)}`);
    }
    git("fetch origin", mono.working);

    // ── The load-bearing assertion ───────────────────────────────────────
    // composeMergeBaseTree's echo-splice path must filter the primary
    // mapping's slice through the auto-ignore patterns, so leaf-canonical
    // common stays out of mono's `leaf/src/common/`. Common is at root only.
    const tip = git("rev-parse origin/shadow/leaf/main", mono.working);
    const tipTree = listTreePaths(mono, tip);
    if (tipTree.includes("leaf/src/common/util.ts")) {
      throw new Error(
        `REGRESSION: leaf/src/common/util.ts present on shadow tip after round-trip ` +
        `--from b. Auto-ignore for intra-pair nested mappings is not filtering the ` +
        `primary mapping's splice in composeMergeBaseTree.\n  Tree:\n    ${tipTree.join("\n    ")}`,
      );
    }
    if (!tipTree.includes("common/util.ts")) {
      throw new Error(
        `common/util.ts missing from shadow tip after round-trip — the common mapping ` +
        `should route it to mono's root.\n  Tree:\n    ${tipTree.join("\n    ")}`,
      );
    }
    void Lc1;

  } finally {
    setBranchFiltersForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().then(() => console.log("PASS  test-autoignore-nested-mapping"))
       .catch(err => { console.error(err); process.exit(1); });
}

export default run;
