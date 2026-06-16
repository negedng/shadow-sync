// Echo-skip: in the export direction (--from a), commits forwarded FROM the
// target (echoes, carrying this pair's target-direction trailer) are pre-mapped
// and skipped in the load-bearing scan, while genuinely-new mono-origin commits
// still replay. Without this, every export re-diffs the whole echo history.
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

function run(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-echo-skip-"));
  try {
    const backend = createRepo(tmp, "backend", { email: "be@x.com", name: "Be" });
    const mono = createRepo(tmp, "mono", { email: "mo@x.com", name: "Mo" });
    git(`remote add backend "${backend.bare}"`, mono.working);

    applyTestOverrides({
      repoRoot: mono.working,
      pairs: [{ name: "be", a: { remote: "origin", url: mono.bare, label: "a-be" }, b: { remote: "backend", url: backend.bare, label: "b-be" }, mappings: [{ a: "be", b: "src" }] }],
      shadowBranchPrefix: "shadow",
    });
    setBranchFiltersForTesting(new Map<string, RegExp[]>([
      ["origin", ["main"].map(compileIgnorePattern)],
      ["backend", ["main"].map(compileIgnorePattern)],
    ]));

    // Backend history -> imported into mono -> becomes echoes.
    commit(backend, { "src/f0.ts": "v0\n" }, "be init");
    git("push origin main", backend.working);
    const N = 6;
    for (let i = 1; i <= N; i++) commit(backend, { [`src/f${i}.ts`]: `v${i}\n` }, `be c${i}`);
    git("push origin main", backend.working);

    commit(mono, { "README.md": "# mono\n", "be/seed.ts": "seed\n" }, "mono seed");
    git("push origin main", mono.working);

    assertEqual(runSync({ from: "b" }).exitCode, 0, "import --from b failed");

    // Integrate the imported shadow into mono main -> echoes now live on main.
    git("fetch origin", mono.working);
    git("checkout main", mono.working);
    git("merge --no-ff origin/b-be/main -m \"integrate backend\"", mono.working);
    git("push origin main", mono.working);

    // A genuinely-new, mono-origin commit that must export.
    commit(mono, { "be/new.ts": "fromMono\n" }, "mono-origin change");
    git("push origin main", mono.working);

    const r = runSync({ from: "a" });
    assertEqual(r.exitCode, 0, `export --from a failed: ${r.stderr.slice(0, 300)}`);

    // The scan must skip the echoes (the N+1 imported backend commits).
    const m = r.stdout.match(/skipping (\d+) already replayed\/echo/);
    if (!m) throw new AssertionError(`no scan summary in:\n${r.stdout.slice(-800)}`);
    const skipped = +m[1];
    console.log(`echoes skipped in load-bearing scan: ${skipped} (imported ${N + 1})`);
    if (skipped < N) throw new AssertionError(`expected >= ${N} echoes skipped, got ${skipped}`);

    // The new mono-origin commit still exported to backend's shadow.
    git("fetch backend", mono.working);
    // mapping be(a) -> src(b): mono be/new.ts lands at src/new.ts on backend's shadow.
    const exported = execSync("git show backend/a-be/main:src/new.ts", { cwd: mono.working, encoding: "utf8" }).replace(/\r\n/g, "\n");
    assertEqual(exported, "fromMono\n", "new mono-origin commit must export to backend shadow");

    console.log("PASS — echo-skip: echoes skipped in scan, new mono commit still exported.");
  } finally {
    setBranchFiltersForTesting(new Map());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
