// A branch newly added to the filter is synced for the first time, so its
// backlog is intentional and must NOT trip the commit-count gate — while an
// over-limit push to an ALREADY-established branch still fails closed.
//
//   1. Establish `main` (one small sync).
//   2. Add a `feature` branch with more commits than maxCommitsPerSync; sync
//      without --allow-many-commits -> succeeds (exempt + logged), content lands.
//   3. Push >limit commits to the established `main`; sync -> fails closed.
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, assertIncludes } from "./assert";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function writeRepoConfig(workDir: string, id: { email: string; name: string }) {
  fs.appendFileSync(path.join(workDir, ".git", "config"),
    `[user]\n\temail = ${id.email}\n\tname = ${id.name}\n[core]\n\tautocrlf = false\n`);
}
interface Repo { bare: string; working: string }
function createRepo(tmp: string, name: string, id: { email: string; name: string }): Repo {
  const bare = path.join(tmp, `${name}-bare`).replace(/\\/g, "/");
  const working = path.join(tmp, `${name}-working`).replace(/\\/g, "/");
  fs.mkdirSync(bare);
  git("init --bare --initial-branch=main", bare);
  execSync(`git clone "${bare}" "${working}"`, { stdio: "pipe" });
  writeRepoConfig(working, id);
  git("symbolic-ref HEAD refs/heads/main", working);
  return { bare, working };
}
function commit(repo: Repo, files: Record<string, string>, msg: string): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
}

function setFilter(branches: string[]) {
  setBranchFiltersForTesting(new Map<string, RegExp[]>([
    ["origin", branches.map(compileIgnorePattern)],
    ["backend", branches.map(compileIgnorePattern)],
  ]));
}

const LIMIT = 3;

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-new-branch-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "be", b: "" }] }],
      shadowBranchPrefix: "shadow",
      maxCommitsPerSync: LIMIT,
    });

    // ── 1. Establish `main` (one small sync). ──────────────────────────────
    setFilter(["main"]);
    commit(backend, { "f0.ts": "v0\n" }, "be init");
    git("push origin main", backend.working);
    commit(mono, { "README.md": "# mono\n" }, "mono seed");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "b" }).exitCode, 0, "[1] establishing sync should pass");

    // ── 2. New `feature` branch with > LIMIT commits -> exempt. ────────────
    git("checkout -b feature main", backend.working);
    const N = LIMIT + 2;
    for (let i = 1; i <= N; i++) commit(backend, { [`feat${i}.ts`]: `feat-v${i}\n` }, `feature c${i}`);
    git("push origin feature", backend.working);
    setFilter(["main", "feature"]);

    const r2 = runSync({ from: "b" });
    assertEqual(r2.exitCode, 0,
      `[2] new-branch sync with ${N} commits must pass under limit ${LIMIT} without --allow-many-commits\n${r2.stderr.slice(0, 400)}`);
    assertIncludes(r2.stdout, "Exempting", "[2] should log the exemption");
    assertIncludes(r2.stdout, "feature", "[2] exemption log should name the new branch");

    git("fetch origin", mono.working);
    const exported = execSync("git show origin/b-be/feature:be/feat1.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    assertEqual(exported, "feat-v1\n", "[2] new-branch content must reach the shadow branch");

    // ── 3. Over-limit push to the ESTABLISHED `main` -> fails closed. ──────
    git("checkout main", backend.working);
    for (let i = 1; i <= LIMIT + 1; i++) commit(backend, { [`m${i}.ts`]: `m${i}\n` }, `main c${i}`);
    git("push origin main", backend.working);

    const r3 = runSync({ from: "b" });
    assertEqual(r3.exitCode, 1, "[3] over-limit push to an established branch must fail closed");
    assertIncludes(r3.stderr, `exceeds the safety limit of ${LIMIT}`, "[3] should report the limit it tripped");
    assertIncludes(r3.stderr, "--allow-many-commits", "[3] should name the override flag");

    console.log("PASS — new-branch-exempt: first-time branch exempt; established-branch overflow still gated.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
