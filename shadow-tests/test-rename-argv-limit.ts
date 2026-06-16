// Regression: a directory rename that deletes MANY files must not leave the
// old paths behind in the shadow. buildReplayedTree applies deletions via
// `git rm --cached -- <paths>` as one argv list; on Windows that overflows
// CreateProcess's 32767-char limit, the spawn fails, `safe:true` swallows it,
// and the deletions are silently dropped (while additions, sent over stdin,
// still apply). Net: the renamed-away directory leaks. FAILS before the fix.
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createTestEnv, setTestBranchAllowlist, runCiSync } from "./harness";
import { AssertionError } from "./assert";

const env = createTestEnv("rename-argv-limit", "backend");
setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

const w = env.remoteWorking;
const g = (c: string) => execSync(`git ${c}`, { cwd: w, stdio: ["pipe", "pipe", "pipe"] });

// Enough files that the rename's deletion list exceeds 32767 chars.
// target path ≈ "backend/deadcode/legacy_module_v1/component_0000.txt" (~52 chars)
const N = 1000;
const oldDir = "deadcode/legacy_module_v1";
const newDir = "deadcode/legacy_module_v2";

fs.mkdirSync(path.join(w, oldDir), { recursive: true });
for (let i = 0; i < N; i++) {
  fs.writeFileSync(path.join(w, oldDir, `component_${String(i).padStart(4, "0")}.txt`), `payload ${i}\n`);
}
g(`add deadcode`); g(`commit -q -m "add legacy_module_v1 (${N} files)"`); g(`push -q origin main`);
runCiSync(env);

// Rename the whole directory in one short command (git mv) — no argv blowup here.
g(`mv ${oldDir} ${newDir}`); g(`commit -q -m "rename legacy_module v1 -> v2"`); g(`push -q origin main`);
runCiSync(env);

// Inspect the shadow tree on origin.
execSync(`git fetch -q origin b-backend/main`, { cwd: env.localRepo, stdio: "pipe" });
const tree = execSync(`git ls-tree -r --name-only origin/b-backend/main`, { cwd: env.localRepo, encoding: "utf8" })
  .split("\n").filter(Boolean);
const oldCount = tree.filter(l => l.includes("legacy_module_v1/")).length;
const newCount = tree.filter(l => l.includes("legacy_module_v2/")).length;

const rmArgChars = N * "backend/deadcode/legacy_module_v1/component_0000.txt".length;
console.log(`rename of ${N} files → engine 'git rm' arg-list ≈ ${rmArgChars} chars (Windows limit 32767)`);
console.log(`shadow old-dir files: ${oldCount} (expect 0)   new-dir files: ${newCount} (expect ${N})`);

env.cleanup();

if (oldCount !== 0) {
  throw new AssertionError(
    `Renamed-away directory leaked into shadow: ${oldCount} stale files under legacy_module_v1/. ` +
    `The rename's deletions were dropped (git rm argv overflow), while the ${newCount} additions applied.`,
  );
}
console.log("PASS — old directory correctly removed from shadow.");
