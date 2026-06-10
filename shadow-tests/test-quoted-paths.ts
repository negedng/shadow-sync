// Quoted-paths: paths that git's default core.quotepath would C-quote in
// plumbing output ("caf\303\251.txt") must survive replay. Without -z parsing,
// the quoted string fails the mapping prefix match and the file silently
// vanishes (non-root source) or lands at a corrupted path (root source).
// Both mappings here are non-root — the silent-drop shape in both directions.
// No core.quotePath override anywhere: the engine must not depend on config.
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSync } from "../shadow-sync";
import { applyTestOverrides, setBranchFiltersForTesting, compileIgnorePattern } from "../shadow-common";
import { assertEqual, AssertionError } from "./assert";

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
// argv-array show: shells mangle unicode/quotes in path args.
function showFile(cwd: string, spec: string): string {
  const r = spawnSync("git", ["show", spec], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) throw new AssertionError(`git show ${spec} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout.replace(/\r\n/g, "\n");
}

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-quoted-paths-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare }, b: { remote: "backend", url: backend.bare }, mappings: [{ a: "be", b: "src" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    commit(backend, { "src/plain.ts": "plain\n" }, "be init");
    git("push origin main", backend.working);
    commit(mono, { "README.md": "# mono\n", "be/seed.ts": "seed\n" }, "mono seed");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "b" }).exitCode, 0, "initial import failed");

    // 1. import: non-ASCII (+ spaces) path through the non-root b-side mapping
    commit(backend, { "src/café résumé.txt": "über\n" }, "be unicode file");
    git("push origin main", backend.working);
    assertEqual(runSync({ from: "b" }).exitCode, 0, "unicode import failed");
    git("fetch origin", mono.working);
    assertEqual(showFile(mono.working, "origin/shadow/be/main:be/café résumé.txt"), "über\n",
      "[1] unicode file must land on mono shadow (silently dropped without -z parsing)");

    // 2. export: same shape through the non-root a-side mapping
    commit(mono, { "be/űrlap (v2).ts": "mező\n" }, "mono unicode file");
    git("push origin main", mono.working);
    assertEqual(runSync({ from: "a" }).exitCode, 0, "unicode export failed");
    git("fetch backend", mono.working);
    assertEqual(showFile(mono.working, "backend/shadow/be/main:src/űrlap (v2).ts"), "mező\n",
      "[2] unicode file must land on backend shadow");

    // 3. quote + backslash in the path — C-quoted by git regardless of
    // core.quotepath, so no config can mask this. NTFS forbids these chars
    // (git-for-windows refuses them at the index level), so plumbing-create
    // the commit and skip the phase on Windows.
    if (process.platform !== "win32") {
      const quoted = 'src/wi"th\\quote.txt';
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"],
        { input: "quoted-content\n", cwd: backend.working, encoding: "utf8" }).stdout.trim();
      const ui = spawnSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${quoted}`],
        { cwd: backend.working, encoding: "utf8" });
      if (ui.status !== 0) throw new AssertionError(`update-index failed: ${ui.stderr}`);
      git('commit -m "be quoted file"', backend.working);
      git("push origin main", backend.working);
      assertEqual(runSync({ from: "b" }).exitCode, 0, "quoted import failed");
      git("fetch origin", mono.working);
      assertEqual(showFile(mono.working, 'origin/shadow/be/main:be/wi"th\\quote.txt'), "quoted-content\n",
        "[3] quote/backslash path must land on mono shadow");
    } else {
      console.log("  [3 info] quote/backslash phase skipped on win32 (NTFS forbids the chars)");
    }

    console.log("PASS — quoted-paths: special-character paths survive replay without quotepath config.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
