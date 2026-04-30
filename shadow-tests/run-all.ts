import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Result { file: string; ok: boolean; output: string; ms: number }

const dir = __dirname;

const testFiles = fs.readdirSync(dir)
  .filter(f => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

// Concurrency 4 is the cliff edge on Windows: above that, the burst of git
// processes triggers Defender realtime scans hard enough to cause transient
// "Permission denied" failures and slows every test by 2-5x.
const concurrency = Math.min(
  Number(process.env.SHADOW_TEST_CONCURRENCY) || 4,
  testFiles.length,
);

console.log(`Found ${testFiles.length} test(s), ${concurrency} workers\n`);

function runOne(file: string): Promise<Result> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn("npx", ["tsx", path.join(dir, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let buf = "";
    child.stdout.on("data", d => { buf += d.toString(); });
    child.stderr.on("data", d => { buf += d.toString(); });
    child.on("exit", code => {
      resolve({
        file: file.replace(/\.ts$/, ""),
        ok: code === 0,
        output: buf,
        ms: Date.now() - startedAt,
      });
    });
  });
}

// Queue-based dispatch: workers pull from a shared queue. A slow test pins
// only its own worker; others keep churning on whatever's left. Tests are
// dispatched in alphabetical order — when we have runtime data, bias toward
// putting known-slow tests at the front so they start first.
async function main() {
  const queue = [...testFiles];
  const results: Result[] = [];
  const startedAt = Date.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const file = queue.shift()!;
      const r = await runOne(file);
      results.push(r);
      const tag = r.ok ? "PASS" : "FAIL";
      const sec = (r.ms / 1000).toFixed(1);
      if (r.ok) {
        console.log(`  ${tag}  ${r.file} (${sec}s)`);
      } else {
        const firstError = r.output.split("\n").find(l => /AssertionError|Error:|✘/.test(l)) ?? "(see output)";
        console.log(`  ${tag}  ${r.file} (${sec}s)\n        ${firstError.trim()}`);
      }
    }
  });
  await Promise.all(workers);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  results.sort((a, b) => a.file.localeCompare(b.file));
  const failures = results.filter(r => !r.ok);

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${results.length - failures.length} passed, ${failures.length} failed, ${results.length} total (${elapsed}s)`);

  // Per-test timings — biggest are the ones to feed back into queue ordering.
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(`Slowest: ${slowest.map(r => `${r.file} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`\n── ${f.file} ──\n${f.output.trim()}`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main();
