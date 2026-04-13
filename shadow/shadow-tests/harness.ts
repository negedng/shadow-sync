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
  /** Bare repo acting as "origin" for shadow branches. */
  originBare: string;
  subdir: string;
  remoteName: string;
  /** Shadow branch prefix (default "shadow"). */
  branchPrefix: string;
  /** All remotes registered in this env (including the primary one). */
  remotes: RemoteInfo[];
  cleanup: () => void;
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Create an isolated test environment with three git repos. */
export function createTestEnv(name: string, subdir = "frontend", branchPrefix = "shadow"): TestEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `shadow-test-${name}-`));
  const remoteBare = path.join(tmpDir, "remote-bare").replace(/\\/g, "/");
  const remoteWorking = path.join(tmpDir, "remote-working").replace(/\\/g, "/");
  const originBare = path.join(tmpDir, "origin-bare").replace(/\\/g, "/");
  const localRepo = path.join(tmpDir, "local").replace(/\\/g, "/");
  const remoteName = "team";

  // 1) Bare remote (external repo)
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

  // 3) Bare "origin" (internal repo on GitHub — target for shadow branches)
  fs.mkdirSync(originBare);
  git("init --bare", originBare);

  // 4) Local internal repo
  fs.mkdirSync(localRepo);
  git("init", localRepo);
  git('config user.email "local@test.com"', localRepo);
  git('config user.name "Local Dev"', localRepo);
  git("config core.autocrlf false", localRepo);
  fs.writeFileSync(path.join(localRepo, "mono.txt"), "internal repo root\n");
  fs.mkdirSync(path.join(localRepo, subdir), { recursive: true });
  git("add -A", localRepo);
  git('commit -m "Initial internal repo commit"', localRepo);
  // Add remotes
  git(`remote add ${remoteName} "${remoteBare}"`, localRepo);
  git(`fetch ${remoteName}`, localRepo);
  git(`remote add origin "${originBare}"`, localRepo);
  git("push origin main", localRepo);

  // Create seed commit on main — records the external repo's current tip
  // so ci-sync knows where to start replaying. The seed commit is on main's
  // history, giving shadow branches shared ancestry for plain git merge.
  const extTip = git("rev-parse team/main", localRepo);
  git(`commit --allow-empty -m "Seed shadow-sync for ${subdir}/ from ${remoteName}/main" -m "Shadow-seed: ${subdir} ${extTip}"`, localRepo);
  git("push origin main", localRepo);

  // Copy shadow scripts and config into local repo so they run from there
  const scriptDir = path.resolve(__dirname, "..");
  const scripts = [
    "shadow-common.ts", "shadow-ci-sync.ts", "shadow-ci-forward.ts",
  ];
  for (const f of scripts) {
    fs.copyFileSync(path.join(scriptDir, f), path.join(localRepo, f));
  }
  // Copy config, overriding branchPrefix if non-default
  const configSrc = path.join(scriptDir, "shadow-config.json");
  const configJson = JSON.parse(fs.readFileSync(configSrc, "utf8"));
  configJson.shadowBranchPrefix = branchPrefix;
  fs.writeFileSync(path.join(localRepo, "shadow-config.json"), JSON.stringify(configJson, null, 2));

  const primary: RemoteInfo = { remoteName, subdir, remoteBare, remoteWorking };

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, localRepo, remoteWorking, remoteBare, originBare, subdir, remoteName, branchPrefix, remotes: [primary], cleanup };
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

  // Create seed commit on main for this remote
  const extTip = git(`rev-parse ${remoteName}/main`, env.localRepo);
  git(`commit --allow-empty -m "Seed shadow-sync for ${subdir}/ from ${remoteName}/main" -m "Shadow-seed: ${subdir} ${extTip}"`, env.localRepo);
  git("push origin main", env.localRepo);

  const info: RemoteInfo = { remoteName, subdir, remoteBare, remoteWorking };
  env.remotes.push(info);
  return info;
}

/** Commit files on the remote (simulates an external developer). null value = delete.
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

// ── Script runners ────────────────────────────────────────────────────────────

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Shell-escape a string for use in a command. */
function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Build env vars — provides remote URLs and config overrides for all scripts. */
function buildEnv(env: TestEnv): Record<string, string> {
  const base: Record<string, string> = {
    ...process.env as Record<string, string>,
    SHADOW_PUSH_ORIGIN: "origin",
  };
  // Always use SHADOW_TEST_REMOTES (JSON format) so the URL is included.
  base.SHADOW_TEST_REMOTES = JSON.stringify(
    env.remotes.map(r => ({ remote: r.remoteName, dir: r.subdir, url: r.remoteBare }))
  );
  return base;
}

/** Build env vars for CI sync script. */
function ciEnv(env: TestEnv): Record<string, string> {
  return buildEnv(env);
}

/** Build env vars for local scripts (export). */
function localEnv(env: TestEnv): Record<string, string> {
  return buildEnv(env);
}

/**
 * Run a shadow script in the test env.
 */
function runScript(env: TestEnv, script: string, args: string[], envVars: Record<string, string>): RunResult {
  const scriptPath = path.join(env.localRepo, script).replace(/\\/g, "/");
  const parts = [shellQuote(scriptPath), ...args.map(shellQuote)];
  const projectDir = path.resolve(__dirname, "..").replace(/\\/g, "/");
  const cmd = `npx --prefix ${shellQuote(projectDir)} tsx ${parts.join(" ")}`;
  const result = spawnSync(cmd, {
    cwd: env.localRepo,
    env: envVars,
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

/**
 * Run shadow-ci-sync.ts — simulates the CI pull workflow.
 * Replays external remote commits into shadow branches on origin.
 * After running, checks out main so the local repo is in a clean state.
 */
export function runCiSync(env: TestEnv): RunResult {
  const result = runScript(env, "shadow-ci-sync.ts", [], ciEnv(env));
  // CI sync switches branches; restore main for subsequent operations
  try { git("checkout main", env.localRepo); } catch { /* may already be on main */ }
  return result;
}

/**
 * Run shadow-ci-forward.ts — simulates the CI forward workflow.
 * Forwards shadow branch content to the external remote.
 */
/** Run shadow-ci-forward.ts — replay local commits to external shadow branch. */
export function runCiForward(env: TestEnv, remote?: RemoteInfo): RunResult {
  const name = remote?.remoteName ?? env.remoteName;
  return runScript(env, "shadow-ci-forward.ts", ["-r", name], localEnv(env));
}

/** Alias — runExport and runCiForward are now the same operation. */
export function runExport(env: TestEnv, _message?: string, extraArgs: string[] = [], remote?: RemoteInfo): RunResult {
  const name = remote?.remoteName ?? env.remoteName;
  return runScript(env, "shadow-ci-forward.ts", ["-r", name, ...extraArgs], localEnv(env));
}

/** Alias for runExport. */
export const runPush = runExport;


/** Pull latest from bare remote into the remote working copy. */
export function pullRemoteWorking(env: TestEnv, remote?: RemoteInfo): void {
  const workDir = remote?.remoteWorking ?? env.remoteWorking;
  git("pull origin main", workDir);
}

/**
 * Read a file from the shadow branch on origin.
 * Returns null if the file or branch doesn't exist.
 */
export function readShadowFile(env: TestEnv, rel: string, remote?: RemoteInfo): string | null {
  const subdir = remote?.subdir ?? env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
  try { git(`fetch origin ${shadowBranch}`, env.localRepo); } catch { return null; }
  try {
    const content = execSync(`git show origin/${shadowBranch}:${subdir}/${rel}`, {
      cwd: env.localRepo, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
    return normalizeLF(content);
  } catch {
    return null;
  }
}

/** Get the commit log from the shadow branch on origin. */
export function getShadowLog(env: TestEnv, n = 20, remote?: RemoteInfo): string {
  const subdir = remote?.subdir ?? env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
  try { git(`fetch origin ${shadowBranch}`, env.localRepo); } catch { return ""; }
  try {
    return git(`log origin/${shadowBranch} --oneline -${n}`, env.localRepo);
  } catch {
    return "";
  }
}

/** Get commit authors from the shadow branch on origin (format: "Name <email>"). */
export function getShadowAuthors(env: TestEnv, n = 20, remote?: RemoteInfo): string {
  const subdir = remote?.subdir ?? env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
  try { git(`fetch origin ${shadowBranch}`, env.localRepo); } catch { return ""; }
  try {
    return git(`log origin/${shadowBranch} --format="%an <%ae>" -${n}`, env.localRepo);
  } catch {
    return "";
  }
}

/** Get full commit messages from the shadow branch on origin. */
export function getShadowLogFull(env: TestEnv, n = 20, remote?: RemoteInfo): string {
  const subdir = remote?.subdir ?? env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
  try { git(`fetch origin ${shadowBranch}`, env.localRepo); } catch { return ""; }
  try {
    return git(`log origin/${shadowBranch} --format="%B" -${n}`, env.localRepo);
  } catch {
    return "";
  }
}

/**
 * Read a file from the external remote's shadow branch (where export pushes).
 * Files are at root level (prefix stripped). Returns null if absent.
 */
export function readExternalShadowFile(env: TestEnv, rel: string, remote?: RemoteInfo): string | null {
  const remoteName = remote?.remoteName ?? env.remoteName;
  const shadowBranch = `${env.branchPrefix}/main`;
  try { git(`fetch ${remoteName} ${shadowBranch}`, env.localRepo); } catch { return null; }
  try {
    const content = execSync(`git show ${remoteName}/${shadowBranch}:${rel}`, {
      cwd: env.localRepo, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
    return normalizeLF(content);
  } catch {
    return null;
  }
}

/** Get full commit messages from the external remote's shadow branch. */
export function getExternalShadowLogFull(env: TestEnv, n = 20, remote?: RemoteInfo): string {
  const remoteName = remote?.remoteName ?? env.remoteName;
  const shadowBranch = `${env.branchPrefix}/main`;
  try { git(`fetch ${remoteName} ${shadowBranch}`, env.localRepo); } catch { return ""; }
  try {
    return git(`log ${remoteName}/${shadowBranch} --format="%B" -${n}`, env.localRepo);
  } catch {
    return "";
  }
}

/**
 * Merge the shadow branch into the local working branch.
 * Shadow commits now carry the full repo tree, so a plain merge works —
 * git finds the seed commit as the merge base and only dir/ files differ.
 */
export function mergeShadow(env: TestEnv, remote?: RemoteInfo): void {
  const subdir = remote?.subdir ?? env.subdir;
  const shadowBranch = `${env.branchPrefix}/${subdir}/main`;
  git(`fetch origin ${shadowBranch}`, env.localRepo);
  git(`merge --no-ff origin/${shadowBranch}`, env.localRepo);
}
