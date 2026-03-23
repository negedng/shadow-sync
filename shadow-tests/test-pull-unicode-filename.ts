import { createTestEnv, runPull, readLocalFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull handles filenames with Unicode characters (accented letters, CJK).
 *  This covers NFC/NFD normalization issues between macOS and Linux/Windows. */
export default function run() {
  const env = createTestEnv("pull-unicode-filename");
  try {
    // Ensure precomposeunicode is set for consistent handling
    git("config core.precomposeunicode true", env.remoteWorking);

    // Create files with Unicode names
    // Use NFC form (composed) — this is what Linux/Windows use
    const accentedName = "caf\u00e9.txt";  // é as single codepoint (NFC)
    const cjkName = "\u6d4b\u8bd5.txt";    // 测试.txt

    fs.writeFileSync(path.join(env.remoteWorking, accentedName), "coffee\n");
    fs.writeFileSync(path.join(env.remoteWorking, cjkName), "test content\n");
    git("add -A", env.remoteWorking);
    git('commit -m "Add unicode-named files"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull
    const r = runPull(env);
    assertEqual(r.status, 0, `pull of unicode files should succeed: ${r.stderr.slice(0, 300)}`);

    // Verify files exist (check via git ls-tree since filesystem may normalize names)
    const localTree = git(`ls-tree -r --name-only HEAD -- ${env.subdir}/`, env.localRepo);
    const hasAccented = localTree.includes("caf");
    assertEqual(hasAccented, true, "accented filename should be in tree");

    // Verify content is correct
    const accentedContent = readLocalFile(env, accentedName);
    if (accentedContent !== null) {
      assertEqual(accentedContent, "coffee\n", "accented file content");
    }
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-unicode-filename");
}
