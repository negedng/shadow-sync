// Minimal repro for the realogic export scaffold leak.
//
// The realogic backend pair maps mono `backend/` → backend repo ROOT
// ({ a: "backend", b: "" }). On export (mono → backend), the mono integrate
// merge's first parent is the UNMAPPED mono seed, so resolveHaltAwareParents
// falls back to targetInit = backend's ROOT commit — which still carries the
// express-generator scaffold (app.js, Dockerfile, …) that backend deleted later
// on its first-parent line. Because the target is ROOT, allTargetsConfined() is
// false, so composeMergeBaseTree skips the echo round-trip splice and takes the
// `!confined` branch: `return firstParentTree(...)` = backend ROOT's tree
// (scaffold present). The mono diff only ADDS backend/ content and never deletes
// the scaffold, so it leaks into the export tip.
//
// The test runs the SAME scenario twice to isolate the cause: once with a
// CONFINED target ({ b:"src" }) as a control — which must keep the scaffold
// deleted (echo round-trip splice runs) — and once with the ROOT target
// ({ b:"" }), which on the buggy engine RESURRECTS the scaffold. The only
// difference between the two runs is the target dir.
import { execSync } from "child_process";
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
function commit(repo: Repo, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo.working, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git("add -A", repo.working);
  git(`commit -m "${msg}"`, repo.working);
  return git("rev-parse HEAD", repo.working);
}
function fileAtRef(repo: Repo, ref: string, p: string): string | null {
  try {
    return execSync(`git show ${ref}:${p}`, { cwd: repo.working, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).replace(/\r\n/g, "\n");
  } catch { return null; }
}

// One full import+export cycle for the given backend target dir. `targetDir`
// "" maps mono be/ ↔ backend ROOT (the buggy realogic config); "src" maps it to
// a confined subdir (the control). Returns the scaffold content on the export
// tip — null means it stayed deleted (correct), non-null means it leaked.
function scaffoldOnExport(tmp: string, label: string, targetDir: string): string | null {
  const backend = createRepo(tmp, `backend-${label}`, { email: "be@x.com", name: "Be" });
  const mono = createRepo(tmp, `mono-${label}`, { email: "mo@x.com", name: "Mo" });
  git(`remote add backend "${backend.bare}"`, mono.working);

  applyTestOverrides({
    repoRoot: mono.working,
    pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "be", b: targetDir }] }],
    shadowBranchPrefix: "shadow",
  });
  setBranchFiltersForTesting(new Map<string, RegExp[]>([
    ["origin", ["main"].map(compileIgnorePattern)],
    ["backend", ["main"].map(compileIgnorePattern)],
  ]));

  const pfx = targetDir ? `${targetDir}/` : "";
  const real = `${pfx}real.txt`;
  const scaffold = `${pfx}scaffold.txt`;

  // backend: scaffold present in the initial template, deleted later on the
  // first-parent line (mirrors backend's 6c7f7ada "initial update"). Tip = none.
  commit(backend, { [real]: "v1\n", [scaffold]: "express-generator\n" }, "initial template (scaffold present)");
  fs.unlinkSync(path.join(backend.working, scaffold));
  git("add -A", backend.working);
  git('commit -m "initial update (remove scaffold)"', backend.working);
  commit(backend, { [real]: "v2\n" }, "edit real");
  git("push origin main", backend.working);
  assertEqual(fileAtRef(backend, "main", scaffold), null, `[${label}] backend tip must not have scaffold (sanity)`);

  // mono seed: empty meeting-place, UNMAPPED — its only role is to be the first
  // parent of the integrate merge, which then resolves to targetInit.
  commit(mono, { "README.md": "# mono\n", "be/.keep": "\n" }, "init monorepo");
  git("push origin main", mono.working);

  // import (--from b): backend → mono be/.
  assertEqual(runSync({ from: "b" }).exitCode, 0, `[${label}] import --from b failed`);
  git("fetch origin", mono.working);
  if (fileAtRef(mono, "origin/b-be/main", "be/real.txt") === null)
    throw new AssertionError(`[${label}] import lost real.txt`);
  if (fileAtRef(mono, "origin/b-be/main", "be/scaffold.txt") !== null)
    throw new AssertionError(`[${label}] import-side bug: scaffold survived import`);

  // integrate shadow into mono main (first parent = unmapped seed).
  git("checkout main", mono.working);
  git('merge --no-ff origin/b-be/main -m "integrate backend"', mono.working);
  git("push origin main", mono.working);
  if (fileAtRef(mono, "main", "be/scaffold.txt") !== null)
    throw new AssertionError(`[${label}] mono main wrongly has scaffold after integrate`);

  // export (--from a): mono → backend shadow.
  assertEqual(runSync({ from: "a" }).exitCode, 0, `[${label}] export --from a failed`);
  git("fetch backend", mono.working);
  if (fileAtRef(mono, "backend/a-be/main", real) === null)
    throw new AssertionError(`[${label}] export lost real.txt`);
  return fileAtRef(mono, "backend/a-be/main", scaffold);
}

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-export-root-scaffold-"));
  try {
    // Control: confined target — echo round-trip splice runs, scaffold stays gone.
    const confined = scaffoldOnExport(tmp, "confined", "src");
    assertEqual(confined, null, "CONTROL: confined target must keep scaffold deleted on export");

    // Bug: root target — composeMergeBaseTree takes the `!confined` branch and
    // returns the targetInit (backend ROOT) tree verbatim, resurrecting scaffold.
    const root = scaffoldOnExport(tmp, "root", "");
    if (root !== null)
      throw new AssertionError("BUG: root-target mapping RESURRECTED scaffold on export (!confined branch returns targetInit tree); confined control did not");

    console.log("PASS — scaffold stays deleted on export for both confined and root targets.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
