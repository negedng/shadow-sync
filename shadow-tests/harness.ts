import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RemoteInfo {
  remoteName: string;
  subdir: string;
  remoteBare: string;
  remoteWorking: string;
}

export interface TestEnv {
  tmpDir: string;
  localRepo: string;
  remoteWorking: string;
  remoteBare: string;
  subdir: string;
  remoteName: string;
  /** All remotes registered in this env (including the primary one). */
  remotes: RemoteInfo[];
  cleanup: () => void;
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Create an isolated test environment with three git repos. */
export function createTestEnv(name: string, subdir = "frontend"): TestEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `shadow-test-${name}-`));
  const remoteBare = path.join(tmpDir, "remote-bare").replace(/\\/g, "/");
  const remoteWorking = path.join(tmpDir, "remote-working").replace(/\\/g, "/");
  const localRepo = path.join(tmpDir, "local").replace(/\\/g, "/");
  const remoteName = "team";

  // 1) Bare remote
  fs.mkdirSync(remoteBare);
  git("init --bare", remoteBare);

  // 2) Working clone of remote — create initial commit so branch exists
  execSync(`git clone "${remoteBare}" "${remoteWorking}"`, { encoding: "utf8", stdio: "pipe" });
  git('config user.email "team@test.com"', remoteWorking);
  git('config user.name "Team Member"', remoteWorking);
  git("config core.autocrlf false", remoteWorking);
  fs.writeFileSync(path.join(remoteWorking, "README.md"), "# Remote Repo\n");
  git("add -A", remoteWorking);
  git('commit -m "Initial commit"', remoteWorking);
  git("push origin main", remoteWorking);

  // 3) Local mono-repo
  fs.mkdirSync(localRepo);
  git("init", localRepo);
  git('config user.email "local@test.com"', localRepo);
  git('config user.name "Local Dev"', localRepo);
  git("config core.autocrlf false", localRepo);
  // Create initial commit (subdir is created later by pull/local commits)
  fs.writeFileSync(path.join(localRepo, "mono.txt"), "mono-repo root\n");
  fs.mkdirSync(path.join(localRepo, subdir), { recursive: true });
  git("add -A", localRepo);
  git('commit -m "Initial mono-repo commit"', localRepo);
  // Add remote
  git(`remote add ${remoteName} "${remoteBare}"`, localRepo);
  git(`fetch ${remoteName}`, localRepo);

  // Copy shadow scripts into local repo so they run from there
  const scriptDir = path.resolve(__dirname, "..");
  for (const f of ["shadow-common.ts", "shadow-pull.ts", "shadow-push.ts"]) {
    fs.copyFileSync(path.join(scriptDir, f), path.join(localRepo, f));
  }

  const primary: RemoteInfo = { remoteName, subdir, remoteBare, remoteWorking };

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, localRepo, remoteWorking, remoteBare, subdir, remoteName, remotes: [primary], cleanup };
}

/** Add an additional remote to an existing test env. Returns a RemoteInfo handle. */
export function addRemote(env: TestEnv, remoteName: string, subdir: string): RemoteInfo {
  const remoteBare = path.join(env.tmpDir, `remote-bare-${remoteName}`).replace(/\\/g, "/");
  const remoteWorking = path.join(env.tmpDir, `remote-working-${remoteName}`).replace(/\\/g, "/");

  // Bare remote
  fs.mkdirSync(remoteBare);
  git("init --bare", remoteBare);

  // Working clone
  execSync(`git clone "${remoteBare}" "${remoteWorking}"`, { encoding: "utf8", stdio: "pipe" });
  git('config user.email "team@test.com"', remoteWorking);
  git('config user.name "Team Member"', remoteWorking);
  git("config core.autocrlf false", remoteWorking);
  fs.writeFileSync(path.join(remoteWorking, "README.md"), `# ${remoteName}\n`);
  git("add -A", remoteWorking);
  git('commit -m "Initial commit"', remoteWorking);
  git("push origin main", remoteWorking);

  // Add to local repo
  git(`remote add ${remoteName} "${remoteBare}"`, env.localRepo);
  git(`fetch ${remoteName}`, env.localRepo);
  fs.mkdirSync(path.join(env.localRepo, subdir), { recursive: true });

  const info: RemoteInfo = { remoteName, subdir, remoteBare, remoteWorking };
  env.remotes.push(info);
  return info;
}

/** Commit files on the remote (simulates a teammate). null value = delete.
 *  Optionally pass a RemoteInfo to target a specific remote (defaults to primary). */
export function commitOnRemote(
  env: TestEnv,
  files: Record<string, string | null>,
  message: string,
  remote?: RemoteInfo,
): void {
  const workDir = remote?.remoteWorking ?? env.remoteWorking;
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workDir, rel);
    if (content === null) {
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        git(`rm "${rel}"`, workDir);
      }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      git(`add "${rel}"`, workDir);
    }
  }
  git(`commit -m "${message}"`, workDir);
  git("push origin main", workDir);
}

/** Commit files in the local repo under a subdir. null value = delete.
 *  Optionally pass a RemoteInfo to target that remote's subdir. */
export function commitOnLocal(
  env: TestEnv,
  files: Record<string, string | null>,
  message: string,
  remote?: RemoteInfo,
): void {
  const subdir = remote?.subdir ?? env.subdir;
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(env.localRepo, subdir, rel);
    if (content === null) {
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        git(`rm "${subdir}/${rel}"`, env.localRepo);
      }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      git(`add "${subdir}/${rel}"`, env.localRepo);
    }
  }
  git(`commit -m "${message}"`, env.localRepo);
}

/** Normalize line endings to LF (Windows git may use CRLF). */
function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Read a file from the local repo's subdir. Returns null if absent. */
export function readLocalFile(env: TestEnv, rel: string, remote?: RemoteInfo): string | null {
  const subdir = remote?.subdir ?? env.subdir;
  const full = path.join(env.localRepo, subdir, rel);
  if (!fs.existsSync(full)) return null;
  return normalizeLF(fs.readFileSync(full, "utf8"));
}

/** Read a file from the remote working copy. Returns null if absent. */
export function readRemoteFile(env: TestEnv, rel: string, remote?: RemoteInfo): string | null {
  const workDir = remote?.remoteWorking ?? env.remoteWorking;
  const full = path.join(workDir, rel);
  if (!fs.existsSync(full)) return null;
  return normalizeLF(fs.readFileSync(full, "utf8"));
}

/** Get local repo commit log (one-line messages). */
export function getLocalLog(env: TestEnv, n = 20): string {
  return git(`log --oneline -${n}`, env.localRepo);
}

/** Get local repo full commit messages. */
export function getLocalLogFull(env: TestEnv, n = 20): string {
  return git(`log --format="%B" -${n}`, env.localRepo);
}

/** Build env vars for running shadow scripts in test mode. */
function testEnv(env: TestEnv): Record<string, string> {
  const base: Record<string, string> = {
    ...process.env as Record<string, string>,
    SHADOW_TEST_SINCE: "",  // no date filter in tests
  };
  if (env.remotes.length > 1) {
    // Multi-remote: pass full REMOTES array as JSON
    base.SHADOW_TEST_REMOTES = JSON.stringify(
      env.remotes.map(r => ({ remote: r.remoteName, dir: r.subdir }))
    );
  } else {
    base.SHADOW_TEST_REMOTE = env.remoteName;
    base.SHADOW_TEST_DIR = env.subdir;
  }
  return base;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Shell-escape a string for use in a command. */
function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Run a shadow script in the test env.
 * Uses the node binary + tsx loader from the current process to avoid
 * npx resolution issues when cwd is a temp directory.
 */
function runScript(env: TestEnv, script: string, args: string[]): RunResult {
  const scriptPath = path.join(env.localRepo, script).replace(/\\/g, "/");
  const parts = [shellQuote(scriptPath), ...args.map(shellQuote)];
  // Use npx tsx with the original project dir in PATH so npx can find tsx
  const projectDir = path.resolve(__dirname, "..").replace(/\\/g, "/");
  const cmd = `npx --prefix ${shellQuote(projectDir)} tsx ${parts.join(" ")}`;
  const result = spawnSync(cmd, {
    cwd: env.localRepo,
    env: testEnv(env),
    encoding: "utf8",
    shell: true,
    timeout: 30000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run shadow-pull.ts in the test env. Optionally target a specific remote. */
export function runPull(env: TestEnv, extraArgs: string[] = [], remote?: RemoteInfo): RunResult {
  const name = remote?.remoteName ?? env.remoteName;
  return runScript(env, "shadow-pull.ts", ["-r", name, ...extraArgs]);
}

/** Run shadow-push.ts in the test env. Optionally target a specific remote. */
export function runPush(env: TestEnv, message: string, extraArgs: string[] = [], remote?: RemoteInfo): RunResult {
  const name = remote?.remoteName ?? env.remoteName;
  return runScript(env, "shadow-push.ts", ["-r", name, "-m", message, ...extraArgs]);
}

/** Pull latest from bare remote into the remote working copy. */
export function pullRemoteWorking(env: TestEnv, remote?: RemoteInfo): void {
  const workDir = remote?.remoteWorking ?? env.remoteWorking;
  git("pull origin main", workDir);
}

/** Resolve conflicts in local repo by writing file content and staging. */
export function resolveConflict(env: TestEnv, rel: string, content: string): void {
  const full = path.join(env.localRepo, env.subdir, rel);
  fs.writeFileSync(full, content);
  git(`add "${env.subdir}/${rel}"`, env.localRepo);
}
