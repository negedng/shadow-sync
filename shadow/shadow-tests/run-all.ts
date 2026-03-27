import * as fs from "fs";
import * as path from "path";

const dir = __dirname;
const testFiles = fs.readdirSync(dir)
  .filter(f => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

let passed = 0;
let failed = 0;
const failures: { file: string; error: string }[] = [];

console.log(`Found ${testFiles.length} test(s)\n`);

for (const file of testFiles) {
  const name = file.replace(/\.ts$/, "");
  try {
    const mod = require(path.join(dir, file));
    const fn = mod.default ?? mod.run;
    if (typeof fn !== "function") {
      throw new Error(`No default export or run() function in ${file}`);
    }
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message?.split("\n").join("\n        ")}`);
    failures.push({ file: name, error: e.message });
    failed++;
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${testFiles.length} total`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  ${f.file}: ${f.error.split("\n")[0]}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
