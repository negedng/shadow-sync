import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Glossary ──────────────────────────────────────────────────────────────────
// pair          Two repo endpoints (a/b) + dir mappings; direction chosen via --from.
// dc            DirectionConfig — a pair resolved into source→target for one run.
// label         Each endpoint's shadow name (e.g. "mb"); names its shadow refs
//               and replay-trailer keys. Must be unique across all pairs.
// replay        Re-creating a source commit on the target with remapped paths.
// trailer       `<sourceLabel>-to-<targetLabel>: <sha> [absorbed…]` commit footer.
//               The persistent source→target mapping: no state file, history IS
//               the state. First value is the direct counterpart; any further
//               values are squash-absorbed halted ancestors.
// shadow ref    <sourceLabel>/<branch> on the target remote — the replayed line
//               the target merges from.
// echo          A source commit that is itself a replay from the target side;
//               recorded, never re-replayed (prevents ping-pong duplication).
// load-bearing  A commit whose mapped+filtered diff changes synced content (or a
//               merge anchoring such commits). Everything else is dropped.
// settled       Scanned in a prior run; verdict is immutable, so re-scans skip it.
// halt          Replay gave up (e.g. mapped parents disagree on outer state). The
//               branch stops there; the operator resolves; later runs absorb it.
// inner/outer   Tree regions inside / outside the mapped target dirs.
// splice        Composing a tree by inserting mapped subtree slices into a base.
//
// Deep dive with worked examples: shadow-sync-explained.html.

// ── Module setup ──────────────────────────────────────────────────────────────

export interface RepoEndpoint {
  remote: string;
  url: string;
  anchorBranch?: string;
  /** This endpoint's shadow label, e.g. "mb". Commits replayed FROM here land
   *  on a shadow ref `<label>/<branch>` on the target, and carry the replay
   *  trailer `<sourceLabel>-to-<targetLabel>`. Must be unique across all pairs. */
  label: string;
}

/** One folder pair: a.dir on side a ↔ b.dir on side b. "" = repo root. */
export interface DirMapping {
  a: string;
  b: string;
}

export interface SyncPair {
  /** Identifies the pair in CLI/config; not used in ref or trailer names. */
  name: string;
  /** Symmetric: direction is chosen at runtime via --from. */
  a: RepoEndpoint;
  b: RepoEndpoint;
  /** 1..N folder mappings. Dirs on each side must be disjoint. */
  mappings: DirMapping[];
}

/** A person's identity on one remote. Replay matches by email (case-insensitive). */
export interface RepoIdentity {
  name: string;
  email: string;
}

/** One person across remotes: remote name → their identity on that remote.
 *  Replaying from remote S to remote T rewrites author/committer matching the
 *  S binding to the T binding; anyone without a matching entry passes through. */
export type IdentityProfile = Record<string, RepoIdentity>;

/** Friendly aliases for the two sides, e.g. { a: "mono", b: "ext" } lets
 *  `--from mono` / `--from ext` stand in for `--from a` / `--from b`. */
export interface Sides { a: string; b: string }

interface ShadowSyncConfig {
  pairs: SyncPair[];
  identities: IdentityProfile[];
  gitConfigOverrides: Record<string, string>;
  maxBuffer: number;
  maxCommitsPerSync: number;
  maxCommitBytes: number;
  sides: Sides | null;
}

interface DirMappingDirected {
  source: string;
  target: string;
}

interface DirectionConfig {
  pair: SyncPair;
  source: RepoEndpoint;
  target: RepoEndpoint;
  /** Direction-flipped pair.mappings. */
  mappings: DirMappingDirected[];
  /** mappings sorted by source-prefix length desc (longest prefix owns a path),
   *  carrying each mapping's original idx. */
  mappingsByDepth: Array<DirMappingDirected & { idx: number }>;
  /** Per-mapping ignores stripping content owned by a sibling mapping nested
   *  under this one's source/target dir. Indexed by mapping idx. Applied only in
   *  spliceMappings — the diff overlay relies on owner-routing instead. */
  autoIgnoreBySourceIdx: IgnoreRule[][];
  autoIgnoreByTargetIdx: IgnoreRule[][];
  identityByEmail: Map<string, RepoIdentity>;
}


function buildDirectionConfig(pair: SyncPair, from: "a" | "b"): DirectionConfig {
  const source = from === "a" ? pair.a : pair.b;
  const target = from === "a" ? pair.b : pair.a;
  const mappings = pair.mappings.map(m =>
    from === "a" ? { source: m.a, target: m.b } : { source: m.b, target: m.a });
  const mappingsByDepth = mappings.map((m, idx) => ({ ...m, idx }))
    .sort((a, b) => b.source.length - a.source.length);
  const autoByMapping = computeAutoIgnorePatterns(pair);
  const autoIgnoreBySourceIdx = autoByMapping.map(p => from === "a" ? p.a : p.b);
  const autoIgnoreByTargetIdx = autoByMapping.map(p => from === "a" ? p.b : p.a);
  const identityByEmail = buildIdentityMap(source.remote, target.remote);
  return { pair, source, target, mappings, mappingsByDepth, autoIgnoreBySourceIdx, autoIgnoreByTargetIdx, identityByEmail };
}

/** Profiles binding both remotes contribute one source→target rewrite each. */
function buildIdentityMap(sourceRemote: string, targetRemote: string): Map<string, RepoIdentity> {
  const map = new Map<string, RepoIdentity>();
  for (const profile of IDENTITIES) {
    const src = profile[sourceRemote];
    const tgt = profile[targetRemote];
    if (src && tgt) map.set(src.email.toLowerCase(), tgt);
  }
  return map;
}

/**
 * Route a source file path through the pair's mappings: the longest-source-
 * prefix mapping owns it. A path is dropped if EITHER the source-side or the
 * target-side .shadowignore matches — within a mapping the inner path is the
 * same on both sides, so both pattern sets test the same `srcRelative`.
 * Returns the mapped target path, or null (no owning mapping / ignored).
 */
function routeSourcePath(
  filePath: string,
  dc: DirectionConfig,
  ignoreBySrcIdx: IgnoreRule[][],
  ignoreByTgtIdx: IgnoreRule[][] = [],
): string | null {
  const owner = dc.mappingsByDepth.find(m =>
    m.source === "" || filePath === m.source || filePath.startsWith(`${m.source}/`));
  if (!owner) return null;
  const srcRelative = owner.source ? filePath.slice(owner.source.length + 1) : filePath;
  if (pathIgnored(ignoreBySrcIdx[owner.idx] ?? [], srcRelative)) return null;
  if (pathIgnored(ignoreByTgtIdx[owner.idx] ?? [], srcRelative)) return null;
  return owner.target ? `${owner.target}/${srcRelative}` : srcRelative;
}

function sourceDirsOf(dc: DirectionConfig): string[] { return dc.mappings.map(m => m.source); }
function targetDirsOf(dc: DirectionConfig): string[] { return dc.mappings.map(m => m.target); }
function anyRootSource(dc: DirectionConfig): boolean { return dc.mappings.some(m => m.source === ""); }
/** True iff every mapping's target is a confined subdir (none at repo root).
 * Drives cross-repo outer-state preservation in composeMergeBaseTree. */
function allTargetsConfined(dc: DirectionConfig): boolean { return !dc.mappings.some(m => m.target === ""); }

/** Validate that a name is safe for use in git commands and path construction. */
export function validateName(value: string, label: string): void {
  if (!value) fail(`${label} must not be empty.`);
  if (value.includes("..")) fail(`${label} must not contain '..'.`);
  if (value.startsWith("/") || value.startsWith("\\")) fail(`${label} must not be an absolute path.`);
  if (value.startsWith("-")) fail(`${label} must not start with '-'.`);
}

// A label is a single ref-path segment and a trailer-key token, so restrict it
// to chars safe in both: letters, digits, hyphen; no leading hyphen.
function validateLabel(pairName: string, label: string): void {
  if (!label || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(label)) {
    fail(`pair "${pairName}" endpoint label "${label}" must be non-empty and match [A-Za-z0-9][A-Za-z0-9-]*`);
  }
}

function validatePair(pair: SyncPair): void {
  if (!pair.mappings || pair.mappings.length === 0) {
    fail(`pair "${pair.name}" must declare at least one mapping`);
  }
  for (const ep of [pair.a, pair.b]) {
    validateLabel(pair.name, ep.label);
  }
  // Only exact-duplicate source/target dirs within a side are ambiguous —
  // nested dirs (e.g. "" + "src/common") route deterministically via
  // longest-prefix in routeSourcePath.
  const aDirs = new Set<string>();
  const bDirs = new Set<string>();
  for (const m of pair.mappings) {
    validateMappingDir(pair.name, m.a);
    validateMappingDir(pair.name, m.b);
    if (aDirs.has(m.a)) fail(`pair "${pair.name}" has duplicate a-dir "${m.a}"`);
    if (bDirs.has(m.b)) fail(`pair "${pair.name}" has duplicate b-dir "${m.b}"`);
    aDirs.add(m.a);
    bDirs.add(m.b);
  }
}

// Endpoint labels name shadow refs (`<label>/<branch>`) and replay trailer keys
// (`<srcLabel>-to-<tgtLabel>`), so they must be globally unique — a collision
// would route two directions to the same ref and conflate their dedup state.
function validatePairs(pairs: SyncPair[]): void {
  for (const pair of pairs) validatePair(pair);
  const seen = new Map<string, string>();
  for (const pair of pairs) {
    for (const ep of [pair.a, pair.b]) {
      const owner = seen.get(ep.label);
      if (owner) fail(`endpoint label "${ep.label}" is used by both "${owner}" and "${pair.name}" — labels must be unique across all pairs`);
      seen.set(ep.label, pair.name);
    }
  }
}

// Side aliases stand in for the literal "a"/"b" on the --from flag. They must
// be a distinct, non-empty pair and must not shadow the literal side letters.
function validateSides(sides: Sides | null): void {
  if (sides == null) return;
  for (const k of ["a", "b"] as const) {
    if (!sides[k] || typeof sides[k] !== "string") fail(`config "sides.${k}" must be a non-empty string`);
    if (sides[k] === "a" || sides[k] === "b") fail(`config "sides.${k}" must not be "a" or "b"`);
  }
  if (sides.a === sides.b) fail(`config "sides" a and b must differ ("${sides.a}")`);
}

// Replays rewrite identities in both directions, so each remote's email must
// belong to at most one profile — a duplicate makes the reverse lookup ambiguous.
function validateIdentities(identities: IdentityProfile[]): void {
  const emailsByRemote = new Map<string, Set<string>>();
  for (const profile of identities) {
    for (const [remote, id] of Object.entries(profile)) {
      if (!id?.name || !id?.email) fail(`identities: binding for remote "${remote}" needs both name and email`);
      const emails = emailsByRemote.get(remote) ?? new Set<string>();
      const key = id.email.toLowerCase();
      if (emails.has(key)) fail(`identities: duplicate email "${id.email}" for remote "${remote}"`);
      emails.add(key);
      emailsByRemote.set(remote, emails);
    }
  }
}

// All prefix matching and git pathspecs use forward slashes with no leading/
// trailing slash; anything else silently matches nothing, so reject it here.
function validateMappingDir(pairName: string, dir: string): void {
  if (dir === "") return;
  if (dir.includes("\\")) fail(`pair "${pairName}" mapping dir "${dir}" must use forward slashes`);
  if (dir.startsWith("/") || dir.endsWith("/")) fail(`pair "${pairName}" mapping dir "${dir}" must not have leading/trailing slashes`);
  if (dir.split("/").includes("..")) fail(`pair "${pairName}" mapping dir "${dir}" must not contain '..'`);
}

export class ShadowSyncError extends Error {
  constructor(msg: string) { super(msg); this.name = "ShadowSyncError"; }
}

export const CONFIG_PATH = process.env.SHADOW_CONFIG ?? path.join(__dirname, "shadow-config.json");

function parseJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (e: any) {
    fail(`Failed to parse ${filePath}: ${e.message}`);
  }
}

// Safety-limit defaults: a single sync run replaying more than this many
// commits, or any one commit replaying more than this many bytes, fails closed
// unless the operator opts in (see mirrorHistory). Override per-deployment via
// the maxCommitsPerSync / maxCommitBytes config fields.
const DEFAULT_MAX_COMMITS_PER_SYNC = 300;
const DEFAULT_MAX_COMMIT_BYTES = 10 * 1024 * 1024;

function loadConfig(): ShadowSyncConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      pairs: [],
      identities: [],
      gitConfigOverrides: {},
      maxBuffer: 50 * 1024 * 1024,
      maxCommitsPerSync: DEFAULT_MAX_COMMITS_PER_SYNC,
      maxCommitBytes: DEFAULT_MAX_COMMIT_BYTES,
      sides: null,
    };
  }

  const doc = parseJsonFile<Record<string, unknown>>(CONFIG_PATH);

  const gitConfigOverrides = (doc.gitConfigOverrides as Record<string, string>) ?? {};
  const maxBuffer = (doc.maxBuffer as number) ?? 50 * 1024 * 1024;
  const maxCommitsPerSync = (doc.maxCommitsPerSync as number) ?? DEFAULT_MAX_COMMITS_PER_SYNC;
  const maxCommitBytes = (doc.maxCommitBytes as number) ?? DEFAULT_MAX_COMMIT_BYTES;

  const pairs = (doc.pairs as SyncPair[]) ?? [];
  validatePairs(pairs);
  const identities = (doc.identities as IdentityProfile[]) ?? [];
  validateIdentities(identities);
  const sides = (doc.sides as Sides | undefined) ?? null;
  validateSides(sides);

  return { pairs, identities, gitConfigOverrides, maxBuffer, maxCommitsPerSync, maxCommitBytes, sides };
}

const config = loadConfig();

export const PAIRS: SyncPair[] = [...config.pairs];
const IDENTITIES: IdentityProfile[] = [...config.identities];
const MAX_BUFFER = config.maxBuffer;
// Mutable so tests can dial the safety gates down without 300 real commits.
let MAX_COMMITS_PER_SYNC = config.maxCommitsPerSync;
let MAX_COMMIT_BYTES = config.maxCommitBytes;
let _sides: Sides | null = config.sides;

/** Resolve a `--from` value to a side. Accepts the literal "a"/"b" or, when
 *  configured, either side alias. Defaults to "b" (pull). Fails on anything else. */
export function resolveFromSide(value: string | undefined): "a" | "b" {
  if (value == null) return "b";
  if (value === "a" || value === "b") return value;
  if (_sides) {
    if (value === _sides.a) return "a";
    if (value === _sides.b) return "b";
  }
  const aliases = _sides ? ` | "${_sides.a}" | "${_sides.b}"` : "";
  fail(`--from must be "a" | "b"${aliases}, got "${value}".`);
}


export function fail(msg: string): never {
  throw new ShadowSyncError(`✘ ${msg}`);
}

/** Orchestrator repo root — git commands use paths relative to it, not the cwd. */
const _repoRootProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (_repoRootProbe.error || !_repoRootProbe.stdout) {
  fail(`Cannot determine repo root (is git installed and cwd inside a repo?): ${_repoRootProbe.error?.message ?? (_repoRootProbe.stderr ?? "").trim()}`);
}
let _repoRoot = _repoRootProbe.stdout.trim();

/** Git config overrides for cross-OS consistency. */
const GIT_CONFIG_OVERRIDES = Object.entries(config.gitConfigOverrides).flatMap(
  ([key, value]) => ["-c", `${key}=${value}`],
);

/** Mutates module state — call before each in-process runSync(). */
export function applyTestOverrides(opts: {
  repoRoot: string;
  pairs: SyncPair[];
  /** Accepted for back-compat with existing tests; labels now name shadow refs. */
  shadowBranchPrefix?: string;
  identities?: IdentityProfile[];
  sides?: Sides | null;
  maxCommitsPerSync?: number;
  maxCommitBytes?: number;
}): void {
  // Validate before mutating module state so a rejected override can't poison
  // a later in-process run.
  validatePairs(opts.pairs);
  const identities = opts.identities ?? config.identities;
  validateIdentities(identities);
  if (opts.sides !== undefined) validateSides(opts.sides);
  _repoRoot = opts.repoRoot;
  PAIRS.length = 0;
  PAIRS.push(...opts.pairs);
  IDENTITIES.length = 0;
  IDENTITIES.push(...identities);
  if (opts.sides !== undefined) _sides = opts.sides;
  MAX_COMMITS_PER_SYNC = opts.maxCommitsPerSync ?? config.maxCommitsPerSync;
  MAX_COMMIT_BYTES = opts.maxCommitBytes ?? config.maxCommitBytes;
}


// Log "<label>: P% (i/total)" each time i crosses a 10% boundary — for long
// phases (>100 items) where per-item logging would be noise.
const PROGRESS_THRESHOLD = 100;
function logDecileProgress(label: string, i: number, total: number): void {
  const step = Math.ceil(total / 10);
  if (step > 0 && (i % step === 0 || i === total)) {
    console.log(`  ${label}: ${Math.round((i / total) * 100)}% (${i}/${total})`);
  }
}

// ── Git primitives ────────────────────────────────────────────────────────────

type GitResult = { stdout: string; stderr: string; status: number; ok: boolean };
type GitOpts = { cwd?: string; plain?: boolean; raw?: boolean; env?: Record<string, string>; input?: string };

/** One A/M/D/T record from `diff-tree -r -z` (no -M/-C, so single-path records). */
interface DiffEntry { newMode: string; newHash: string; status: string; filePath: string }

export function git(args: string[], opts?: GitOpts & { safe?: false }): string;
export function git(args: string[], opts: GitOpts & { safe: true }): GitResult;
export function git(args: string[], opts?: GitOpts & { safe?: boolean }): string | GitResult {
  const fullArgs = opts?.plain ? args : [...GIT_CONFIG_OVERRIDES, ...args];
  const trim = (s: string) => opts?.raw ? s : s.trim();

  const r = spawnSync("git", fullArgs, {
    encoding: "utf8", cwd: opts?.cwd ?? _repoRoot, maxBuffer: MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"],
    ...(opts?.input != null ? { input: opts.input } : {}),
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });

  if (opts?.safe) {
    if (r.error) return { stdout: "", stderr: `Failed to spawn git: ${r.error.message}`, status: 1, ok: false };
    return {
      stdout: trim(r.stdout ?? ""),
      stderr: (r.stderr ?? "").trim(),
      status: r.status ?? 1,
      ok: r.status === 0,
    };
  }

  if (r.error) throw new Error(`Failed to spawn git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`);
  return trim(r.stdout ?? "");
}

export function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", ref], { safe: true }).ok;
}

/** Keep refs from list that exists locally */
function filterExistingRefs(refs: string[]): string[] {
  if (refs.length === 0) return [];
  const result = git(
    ["for-each-ref", "--format=%(refname)", ...refs.map(r => `refs/remotes/${r}`)],
    { safe: true },
  );
  // Fail loud: an empty result here silently empties syncedShaMap downstream.
  if (!result.ok) fail(`for-each-ref failed: ${result.stderr}`);
  if (!result.stdout) return [];
  const existing = new Set(
    result.stdout.split("\n").filter(Boolean).map(l => l.replace(/^refs\/remotes\//, "")),
  );
  return refs.filter(r => existing.has(r));
}


/** Which of `shas` resolve to a present object — one `cat-file --batch-check`
 *  instead of a `rev-parse` spawn per sha. */
function batchObjectsExist(shas: string[]): Set<string> {
  const present = new Set<string>();
  const uniq = [...new Set(shas)].filter(Boolean);
  if (uniq.length === 0) return present;
  const res = git(["cat-file", "--batch-check"], { input: uniq.join("\n") + "\n", safe: true, raw: true });
  if (!res.ok) return present;
  for (const line of res.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    // "<sha> <type> <size>" for present; "<sha> missing" for absent.
    if (line.slice(sp + 1).startsWith("missing")) continue;
    present.add(line.slice(0, sp));
  }
  return present;
}


/** Byte size of each present blob in `shas` — one `cat-file --batch-check`
 *  instead of a spawn per sha. Missing objects are omitted from the map. */
function batchBlobSizes(shas: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  const uniq = [...new Set(shas)].filter(Boolean);
  if (uniq.length === 0) return sizes;
  const res = git(["cat-file", "--batch-check"], { input: uniq.join("\n") + "\n", safe: true, raw: true });
  if (!res.ok) return sizes;
  for (const line of res.stdout.split("\n")) {
    // "<sha> <type> <size>" for present; "<sha> missing" for absent.
    const m = line.match(/^([0-9a-f]+) \S+ (\d+)$/);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  return sizes;
}

/** Every endpoint label across all pairs — the prefixes that mark shadow refs. */
function allLabels(): string[] {
  return PAIRS.flatMap(p => [p.a.label, p.b.label]);
}

export function listRemoteBranches(remote: string): string[] {
  const labels = allLabels();
  return git(["branch", "-r"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith(`${remote}/`) && !l.includes("->"))
    .map(l => l.replace(`${remote}/`, ""))
    .filter(b => !labels.some(label => b === label || b.startsWith(`${label}/`)));
}

/** Shadow ref name for content replayed FROM the endpoint with `sourceLabel`. */
export function shadowBranchName(sourceLabel: string, branch: string): string {
  return `${sourceLabel}/${branch}`;
}

/** Ensure a git remote is configured at the endpoint's URL — add or update as needed. */
export function ensureRemote(endpoint: RepoEndpoint): void {
  const existing = git(["remote", "get-url", endpoint.remote], { safe: true });
  if (!existing.ok) {
    git(["remote", "add", endpoint.remote, endpoint.url]);
  } else if (existing.stdout !== endpoint.url) {
    git(["remote", "set-url", endpoint.remote, endpoint.url]);
  }
}


// Parse `-z` records: ":<modes> <shas> <status>\0<path>\0". -z is load-bearing:
// it emits paths verbatim, where the default core.quotepath C-quotes paths with
// non-ASCII/special characters — breaking mapping prefix matches and silently
// dropping those files from the replay.
function parseDiffTreeZ(out: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const m = tokens[i].match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([AMDT])$/);
    if (!m) continue;
    entries.push({ newMode: m[1], newHash: m[2], status: m[3], filePath: tokens[i + 1] });
  }
  return entries;
}

/** diff-tree -r -z between two commits, restricted to the synced dirs.
 *  With a "" source the whole tree is in scope, so the pathspec is skipped
 *  (it would exclude siblings of more-specific sources). */
function diffSyncedDirs(parent: string, commit: string, dc: DirectionConfig):
  { ok: boolean; stderr: string; entries: DiffEntry[] } {
  const args = ["diff-tree", "-r", "-z", parent, commit];
  if (!anyRootSource(dc)) args.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
  const res = git(args, { safe: true, raw: true });
  return { ok: res.ok, stderr: res.stderr, entries: res.ok ? parseDiffTreeZ(res.stdout) : [] };
}

// True iff `<hash>:<sourceDir>` resolves to a tree. Root ("") is always
// present; memoized since a non-root slice's presence rarely changes.
const _slicePresentCache = new Map<string, boolean>();
function slicePresent(hash: string, sourceDir: string): boolean {
  if (!sourceDir) return true;
  const key = `${hash}:${sourceDir}`;
  const hit = _slicePresentCache.get(key);
  if (hit !== undefined) return hit;
  const r = git(["cat-file", "-t", `${hash}:${sourceDir}`], { safe: true });
  const present = r.ok && r.stdout === "tree";
  _slicePresentCache.set(key, present);
  return present;
}

/** Stage `removals` (mode-0 lines) and `additions` ("<mode> <sha>\t<path>"
 *  lines) in one `update-index --index-info` over stdin — argv-based `git rm`
 *  overflows CreateProcess on Windows for large file lists. */
function applyIndexInfo(
  idxEnv: { GIT_INDEX_FILE: string },
  removals: string[],
  additions: string[],
): void {
  if (removals.length === 0 && additions.length === 0) return;
  const lines = [
    ...removals.map(p => `0 ${NULL_SHA}\t${p}`),
    ...additions,
  ];
  // -z: NUL-terminated records, paths taken verbatim (no C-unquoting).
  git(["update-index", "-z", "--index-info"], { env: idxEnv, input: lines.join("\0") + "\0" });
}

/** Allocate a private git index, run `fn` against it, then delete it. */
function withTmpIndex<T>(label: string, fn: (idxEnv: { GIT_INDEX_FILE: string }) => T): T {
  const tmpIndex = path.join(
    os.tmpdir(),
    `shadow-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    return fn({ GIT_INDEX_FILE: tmpIndex });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

let _emptyTreeSha: string | null = null;
function emptyTreeSha(): string {
  if (_emptyTreeSha === null) _emptyTreeSha = git(["mktree"], { input: "" });
  return _emptyTreeSha;
}

// ── Trailer machinery ─────────────────────────────────────────────────────────

/** Squash-absorbed replay counterpart: `target` stands in for the absorbed
 *  source commit only on lineages that contain `absorber` (the squash's own
 *  source commit). */
interface AbsorbedEntry { target: string; absorber: string }
type AbsorbedMap = Map<string, AbsorbedEntry[]>;

interface ScopedMappings { direct: Map<string, string>; absorbed: AbsorbedMap }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One trailer per direction, keyed by the two endpoint labels: its value lists
// the source commits this replay stands in for — the first is the direct
// counterpart, the rest are squash-absorbed halted ancestors.
function replayTrailerKey(sourceLabel: string, targetLabel: string): string {
  return `${sourceLabel}-to-${targetLabel}`;
}

// The trailer this direction WRITES onto target commits.
function sourceTrailerKey(dc: DirectionConfig): string {
  return replayTrailerKey(dc.source.label, dc.target.label);
}

// The opposite direction's trailer — on a source commit it marks an echo.
function targetTrailerKey(dc: DirectionConfig): string {
  return replayTrailerKey(dc.target.label, dc.source.label);
}

/** Match a replay trailer line, capturing its first value: {src}-to-{tgt}: {hash} */
function targetTrailerRegex(dc: DirectionConfig): RegExp {
  return new RegExp(`^${escapeRegex(targetTrailerKey(dc))}:\\s*([0-9a-f]{7,40})`);
}


export function appendTrailer(message: string, trailer: string): string {
  const result = git(["interpret-trailers", "--trailer", trailer],
    { safe: true, input: message, raw: true });
  if (!result.ok) {
    const trimmed = message.trimEnd();
    return `${trimmed}\n\n${trailer}\n`;
  }
  return result.stdout;
}

function hasTrailer(trailers: string, key: string): boolean {
  return new RegExp(`^${escapeRegex(key)}:`, "m").test(trailers);
}

// Drop this pair's replay trailers (both directions) before re-recording an
// echo, so the new trailer doesn't pile up beside a stale one.
function stripReplayedTrailers(message: string, dc: DirectionConfig): string {
  const keys = [sourceTrailerKey(dc), targetTrailerKey(dc)];
  return message.split("\n")
    .filter(l => !keys.some(k => l.startsWith(`${k}:`)))
    .join("\n").trimEnd();
}


/**
 * Build source→target mappings from replay trailers. Each trailer's value is a
 * SHA list: the first is the direct (globally valid) counterpart; the rest are
 * squash-absorbed and scoped to the lineage of that first value (the absorber).
 */
function extractTrailerMappings(logArgs: string[], replayedKey: string): ScopedMappings {
  const direct = new Map<string, string>();
  const absorbed: AbsorbedMap = new Map();
  const result = git(
    [...logArgs, `--format=%H%x01%(trailers:key=${replayedKey},valueonly,separator=%x20)`],
    { safe: true },
  );
  // Fail loud: treating a failed log as "nothing replayed yet" would re-replay
  // the whole history and diverge from any hand-built halt resolution.
  if (!result.ok) fail(`Failed to read replay trailers (git log): ${result.stderr}`);
  if (!result.stdout) return { direct, absorbed };
  const isSha = (s: string) => /^[0-9a-f]{7,40}$/.test(s);
  for (const line of result.stdout.split("\n")) {
    const [targetHash, replayedRaw] = line.split("\x01");
    if (!targetHash || !replayedRaw) continue;
    const vals = replayedRaw.split(/\s+/).filter(isSha);
    if (vals.length === 0) continue;
    const absorber = vals[0];
    // Log is newest-first; first occurrence (newest replay) wins.
    if (!direct.has(absorber)) direct.set(absorber, targetHash);
    for (const src of vals.slice(1)) {
      const list = absorbed.get(src) ?? [];
      list.push({ target: targetHash, absorber });
      absorbed.set(src, list);
    }
  }
  return { direct, absorbed };
}


// Batched trailer fetch (one `git log` per ~500 commits, NUL-separated).
function fetchTrailersBatch(hashes: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (hashes.length === 0) return map;
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const res = git(["log", "--no-walk", "-z", "--format=%H%n%(trailers:only,unfold=true)", ...chunk],
      { safe: true, raw: true });
    if (!res.ok) fail(`Failed to fetch trailers for ${chunk.length} commit(s): ${res.stderr}`);
    for (const rec of res.stdout.split("\0")) {
      if (!rec) continue;
      const nl = rec.indexOf("\n");
      const hash = (nl < 0 ? rec : rec.slice(0, nl)).trim();
      if (hash) map.set(hash, nl < 0 ? "" : rec.slice(nl + 1));
    }
  }
  return map;
}

// The hash of the existing commit this one is a copy of, read from the first
// matching replay trailer in its footer — or null if it carries no such trailer.
function matchOriginalHash(commitTrailers: string, dcTrailerRe: RegExp): string | null {
  const match = commitTrailers.split("\n").map(l => l.match(dcTrailerRe)).find(m => m);
  return match ? match[1] : null;
}


// ── Preflight checks ──────────────────────────────────────────────────────────

type PreflightWarning = { level: "error" | "warn"; code: string; message: string };

export function runPreflightChecks(ref: string): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const error = (code: string, message: string) => warnings.push({ level: "error", code, message });

  const shallow = git(["rev-parse", "--is-shallow-repository"], { safe: true });
  if (shallow.ok && shallow.stdout === "true") {
    error("SHALLOW_CLONE", "This repository is a shallow clone. Shadow sync requires full history.\n  Run: git fetch --unshallow");
  }

  // core.ignorecase=true (Windows/macOS default) folds case-conflicting paths
  // in update-index --index-info, silently dropping one of them from the
  // replayed tree. Skip the walk on Linux where the index preserves both.
  if (process.platform === "win32" || process.platform === "darwin") {
    const tree = git(["ls-tree", "-r", "--name-only", "-z", ref], { safe: true, raw: true });
    if (tree.ok && tree.stdout) {
      const lower = new Map<string, string>();
      for (const filePath of tree.stdout.split("\0").filter(Boolean)) {
        const existing = lower.get(filePath.toLowerCase());
        if (existing && existing !== filePath) {
          error("CASE_CONFLICT", `Case conflict: '${existing}' and '${filePath}' differ only in case.\n  This will cause data loss on case-insensitive filesystems (Windows/macOS).`);
        }
        lower.set(filePath.toLowerCase(), filePath);
      }
    }
  }

  return warnings;
}

/** Pure (no I/O) — see printPreflightResults for the side-effecting version. */
export function formatPreflightResults(warnings: PreflightWarning[]): { lines: string[]; errorCount: number; ok: boolean } {
  const lines = warnings.map(w => `${w.level === "error" ? "✘" : "⚠"} [${w.code}] ${w.message}`);
  const errorCount = warnings.filter(w => w.level === "error").length;
  if (errorCount > 0) lines.push(`\nAborting due to ${errorCount} error(s).`);
  return { lines, errorCount, ok: errorCount === 0 };
}

export function printPreflightResults(warnings: PreflightWarning[]): boolean {
  const { lines, ok } = formatPreflightResults(warnings);
  for (const line of lines) console.error(line);
  return ok;
}

// ── Commit metadata & collection ──────────────────────────────────────────────

interface CommitMeta {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  trailers: string;
  short: string;
}

interface TopoCommit {
  hash: string;
  parents: string[];
}

// Small LRU: the echo check re-reads each commit's parents, which on a linear
// chain are the previous iterations' commits — recency captures nearly all hits.
const META_CACHE_MAX = 256;
const _commitMetaCache = new Map<string, CommitMeta>();
function getCommitMeta(hash: string): CommitMeta {
  const cached = _commitMetaCache.get(hash);
  if (cached) {
    _commitMetaCache.delete(hash);     // bump to most-recently-used
    _commitMetaCache.set(hash, cached);
    return cached;
  }
  // NUL-separated; %B last so its newlines can't shift fields.
  const format = ["%an", "%ae", "%aD", "%cn", "%ce", "%cD", "%h: %s", "%(trailers:only,unfold=true)", "%B"]
    .join("%x00");
  const raw = git(["log", "-1", `--format=${format}`, hash]);
  const parts = raw.split("\0");
  const meta: CommitMeta = {
    hash,
    authorName: parts[0],
    authorEmail: parts[1],
    authorDate: parts[2],
    committerName: parts[3],
    committerEmail: parts[4],
    committerDate: parts[5],
    short: parts[6],
    trailers: parts[7],
    message: parts[8],
  };
  _commitMetaCache.set(hash, meta);
  if (_commitMetaCache.size > META_CACHE_MAX) {
    _commitMetaCache.delete(_commitMetaCache.keys().next().value!);  // evict LRU
  }
  return meta;
}

function buildCommitEnv(meta: CommitMeta, identityByEmail: Map<string, RepoIdentity>): Record<string, string> {
  const author = identityByEmail.get(meta.authorEmail.toLowerCase())
    ?? { name: meta.authorName, email: meta.authorEmail };
  const committer = identityByEmail.get(meta.committerEmail.toLowerCase())
    ?? { name: meta.committerName, email: meta.committerEmail };
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: meta.authorDate,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: meta.committerDate,
  };
}


// ── Source graph ─────────────────────────────────────────────────────────────
// In-memory commit graph, built once per direction from two batched git calls;
// the whole scan reads it instead of spawning a `git log` per commit.
interface SourceGraph {
  parents: Map<string, string[]>;
  index: Map<string, number>;     // topo position, 0 = newest; a commit's parents have larger index
  syncTouched: Set<string>;       // commits whose own diff touched the synced dirs (ignore-blind)
}

function collectSourceGraph(dc: DirectionConfig, branches: string[]): SourceGraph {
  const refs = branches.map(b => `${dc.source.remote}/${b}`);
  // Call 1: the whole reachable graph in topo order with parent edges.
  const g = git(["log", "--topo-order", "--format=%H %P", ...refs], { safe: true });
  if (!g.ok) fail(`log --format=%H %P failed: ${g.stderr}`);
  const parents = new Map<string, string[]>();
  const index = new Map<string, number>();
  let i = 0;
  for (const line of g.stdout.split("\n")) {
    if (!line) continue;
    // filter(Boolean): a root commit's empty %P leaves a trailing space.
    const parts = line.split(" ").filter(Boolean);
    parents.set(parts[0], parts.slice(1));
    index.set(parts[0], i++);
  }
  // Call 2: commits whose own diff touched the synced dirs. With a root source
  // there is no pathspec, so every commit is in scope.
  const syncTouched = new Set<string>();
  if (dc.mappings.length > 0 && !anyRootSource(dc)) {
    const t = git(["log", "--full-history", "--format=%H", ...refs, "--", ...sourceDirsOf(dc).map(d => `${d}/`)], { safe: true });
    if (!t.ok) fail(`log --full-history (sync-touched) failed: ${t.stderr}`);
    for (const h of t.stdout.split("\n")) if (h) syncTouched.add(h);
  } else {
    for (const h of index.keys()) syncTouched.add(h);
  }
  return { parents, index, syncTouched };
}

// A commit's true parents from the loaded graph, with a defensive `git log %P`
// fallback for any hash outside it.
function graphParentsOf(graph: SourceGraph, hash: string): string[] {
  const fromGraph = graph.parents.get(hash);
  if (fromGraph) return fromGraph;
  const res = git(["log", "-1", "--format=%P", hash], { safe: true });
  if (!res.ok) fail(`log -1 --format=%P ${hash} failed: ${res.stderr}`);
  return res.stdout ? res.stdout.split(/\s+/).filter(Boolean) : [];
}

// Walk the first-parent line from `start` to the first commit for which `stop`
// holds; return that commit's source hash, or undefined if the walk reaches a
// root without a hit. Treesame merges that join two kept lines are kept by
// isLoadBearing, so any mapped ancestor of a dropped commit is reachable on the
// first-parent line — no all-ancestors walk needed.
function firstParentUntil(
  graph: SourceGraph,
  start: string,
  stop: (hash: string) => boolean,
): string | undefined {
  let h: string | undefined = start;
  while (h && !stop(h)) h = graphParentsOf(graph, h)[0];
  return h;
}

// The scan list: {sync-touched commits} ∪ {all merges} — equivalent to
// `git log --full-history --parents -- <dirs>` (verified). Emitted oldest-first
// so the scan sees ancestors before descendants.
function deriveSourceCommits(g: SourceGraph): TopoCommit[] {
  const out: TopoCommit[] = [];
  const keys = [...g.parents.keys()];
  for (let i = keys.length - 1; i >= 0; i--) {
    const h = keys[i];
    const ps = g.parents.get(h)!;
    if (g.syncTouched.has(h) || ps.length >= 2) out.push({ hash: h, parents: ps });
  }
  return out;
}

// ── Replay-list filtering ───────────────────────────────────────────────────

// True iff the commit's diff vs `parent`, after mapping + ignore filtering,
// has any surviving path — i.e. it changes content that flows to the target.
function sliceChangedVsParent(
  parent: string,
  commit: string,
  dc: DirectionConfig,
  ignoreBySrc: IgnoreRule[][],
): boolean {
  const diff = diffSyncedDirs(parent, commit, dc);
  if (!diff.ok) return true;  // fail closed: keep
  return diff.entries.some(e => routeSourcePath(e.filePath, dc, ignoreBySrc) !== null);
}

// git's canonical empty-tree object — the "parent" for a root commit's diff so
// every blob the commit introduces counts toward its replayed size.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Blob SHAs a commit would actually replay: its diff vs first parent (empty
// tree for a root commit), restricted to mapped + non-ignored paths (same
// predicate as sliceChangedVsParent) and to content-bearing statuses (A/M/T).
function commitReplayedBlobShas(c: TopoCommit, dc: DirectionConfig): string[] {
  const parent = c.parents[0] ?? EMPTY_TREE;
  const diff = diffSyncedDirs(parent, c.hash, dc);
  if (!diff.ok) return [];  // size unknown — count check / replay surfaces failures
  const ignoreBySrc = sourceIgnoreByIdx(dc, c.hash, c.parents[0]);
  return diff.entries
    .filter(e => e.status !== "D" && routeSourcePath(e.filePath, dc, ignoreBySrc) !== null)
    .map(e => e.newHash);
}

// Compact byte size for operator-facing messages, e.g. 12.3 MB / 900 KB.
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Per-commit replayed byte size for every commit, summing surviving blob sizes.
// One cat-file batch across all commits' blobs (a shared blob is summed once
// per commit it appears in, which is the size that commit replays).
function commitReplayedBytes(commits: TopoCommit[], dc: DirectionConfig): Map<string, number> {
  const blobsByCommit = commits.map(c => commitReplayedBlobShas(c, dc));
  const sizes = batchBlobSizes(blobsByCommit.flat());
  const bytes = new Map<string, number>();
  commits.forEach((c, i) => {
    bytes.set(c.hash, blobsByCommit[i].reduce((sum, sha) => sum + (sizes.get(sha) ?? 0), 0));
  });
  return bytes;
}

// Returns true iff `git log pi ^p1` contains any commit in keptSet —
// i.e., Pi contributes at least one kept commit not already reachable from P1.
function hasKeptExclusiveAncestor(pi: string, p1: string, keptSet: Set<string>): boolean {
  if (keptSet.size === 0) return false;
  const result = git(["log", "--format=%H", pi, `^${p1}`], { safe: true });
  // Fail closed (keep): dropping the merge on a failed log could orphan the
  // side branch's kept commits from the shadow tip. Same direction as
  // sliceChangedVsParent's failure path.
  if (!result.ok) return true;
  for (const line of result.stdout.split("\n")) {
    const h = line.trim();
    if (h && keptSet.has(h)) return true;
  }
  return false;
}

/**
 * Drop iff the commit's effective source tree (composed across all mappings)
 * matches the 1st parent's AND (for merges) every non-first parent's
 * exclusive ancestry above its merge-base with the 1st parent is empty of
 * kept commits. P1 is the trunk; any Pi (i>=1) contributing a kept commit
 * anchors the merge.
 */
function isLoadBearing(
  c: TopoCommit,
  dc: DirectionConfig,
  keptSet: Set<string>,
): boolean {
  if (c.parents.length === 0) return true;

  const p1 = c.parents[0];

  // A source slice missing at c or p1 (non-root dir not born yet, or just
  // vanished) always load-bears.
  for (const m of dc.mappings) {
    if (!slicePresent(c.hash, m.source) || !slicePresent(p1, m.source)) return true;
  }

  const ignoreBySrc = sourceIgnoreByIdx(dc, c.hash, p1);
  if (sliceChangedVsParent(p1, c.hash, dc, ignoreBySrc)) return true;

  if (c.parents.length === 1) return false;
  // Merge, treesame to P1: it anchors only if a non-first parent contributes a
  // kept commit exclusive of P1 (`git log pi ^p1` ∩ keptSet).
  for (let i = 1; i < c.parents.length; i++) {
    if (hasKeptExclusiveAncestor(c.parents[i], p1, keptSet)) return true;
  }
  return false;
}

function dropNonLoadBearingCommits(
  commits: TopoCommit[],
  dc: DirectionConfig,
  alreadySynced: Set<string>,
  alreadySettled: Set<string>,
): TopoCommit[] {
  // commits arrive --topo-order --reverse (oldest first), so by the time we
  // evaluate a merge, every ancestor's keep/drop decision is already in keptSet.
  const keptSet = new Set<string>();
  const kept: TopoCommit[] = [];
  const total = commits.length;
  const showProgress = total > PROGRESS_THRESHOLD;
  let i = 0;
  for (const c of commits) {
    i++;
    // An already-synced commit was load-bearing-kept in a prior run.
    if (alreadySynced.has(c.hash)) {
      keptSet.add(c.hash);
    } else if (alreadySettled.has(c.hash)) {
      // Reachable from a prior-run frontier and not mapped -> dropped in an earlier sync.
      continue;
    } else if (isLoadBearing(c, dc, keptSet)) {
      keptSet.add(c.hash);
      kept.push(c);
    }
    if (showProgress) logDecileProgress("Scanned", i, total);
  }
  return kept;
}

/**
 * Map echo commits (source → target SHA) so they count as already replayed.
 * Keyed on this pair's target-direction trailer only — a sibling pair's
 * trailer must NOT match, so cross-pair commits still replay.
 *
 * Import is idempotent, so exactly one genuine echo points at each target. A
 * cherry-pick copies the trailer verbatim, producing a SECOND commit pointing
 * at the same target — that is a fresh change, not an echo, and must replay.
 * Candidates arrive oldest-first, so the first commit per target wins (the
 * genuine echo) and later duplicates are left unmapped. Absorption packs all
 * its originals into one trailer on one commit and matchOriginalHash reads only
 * the first, so distinct echo commits never share a target unless one is a copy.
 */
function addEchoMappings(
  sourceCommits: TopoCommit[],
  dc: DirectionConfig,
  syncedShaMap: Map<string, string>,
): void {
  const echoKey = targetTrailerKey(dc);
  const echoRe = targetTrailerRegex(dc);
  const pending = sourceCommits.filter(c => !syncedShaMap.has(c.hash)).map(c => c.hash);
  if (pending.length === 0) return;

  const trailersByHash = fetchTrailersBatch(pending);
  const candidates: Array<{ hash: string; target: string }> = [];
  for (const hash of pending) {
    const trailers = trailersByHash.get(hash) ?? "";
    if (!hasTrailer(trailers, echoKey)) continue;
    const target = matchOriginalHash(trailers, echoRe);
    if (target) candidates.push({ hash, target });
  }
  if (candidates.length === 0) return;

  const present = batchObjectsExist(candidates.map(c => c.target));
  const claimed = new Set<string>();
  for (const { hash, target } of candidates) {
    if (!present.has(target) || claimed.has(target)) continue;
    claimed.add(target);
    syncedShaMap.set(hash, target);
  }
}

/**
 * Settled = everything reachable from the newest already-replayed commit on
 * each branch's first-parent line. Those verdicts are immutable (they depend
 * only on fixed trees/ancestor verdicts), so the scan skips re-deriving them.
 */
function computeSettledCommits(
  graph: SourceGraph,
  branches: string[],
  dc: DirectionConfig,
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
): Set<string> {
  const settled = new Set<string>();
  if (syncedShaMap.size === 0 && absorbedMap.size === 0) return settled;

  const refs = branches.map(b => `refs/remotes/${dc.source.remote}/${b}`);
  const res = git(["for-each-ref", "--format=%(objectname)", ...refs], { safe: true });
  if (!res.ok || !res.stdout) return settled;
  const tips = res.stdout.split("\n").map(s => s.trim()).filter(Boolean);

  // Frontier per branch: first-parent walk to the newest mapped commit (if any).
  const frontier: string[] = [];
  for (const tip of tips) {
    const h = firstParentUntil(graph, tip, x => syncedShaMap.has(x) || absorbedMap.has(x));
    if (h) frontier.push(h);
  }

  // Reachability must follow ALL parents — a dropped commit can sit on a
  // non-first-parent side branch below a mapped merge.
  return collectReachable(graph, frontier);
}

// Every commit reachable from `startHashes` over all parent edges.
function collectReachable(graph: SourceGraph, startHashes: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...startHashes];
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    for (const p of graph.parents.get(h) ?? []) stack.push(p);
  }
  return seen;
}

// ── Ignore patterns ──────────────────────────────────────────────

// One compiled .shadowignore line. `negated` is a `!` re-include; `dirOnly` (a
// trailing `/`) matches directories only. Rules are ordered: later wins.
export interface IgnoreRule { regex: RegExp; negated: boolean; dirOnly: boolean; }

// gitignore-faithful match of a mapping-relative file path against ordered
// rules. A file is ignored if any ancestor directory is ignored (you cannot
// re-include under an excluded dir) or the file's own last match ignores it.
export function pathIgnored(rules: IgnoreRule[], filePath: string): boolean {
  if (rules.length === 0) return false;
  const segs = filePath.split("/");
  for (let k = 1; k < segs.length; k++) {
    if (matchState(rules, segs.slice(0, k).join("/"), true)) return true;
  }
  return matchState(rules, filePath, false);
}

// Last-match-wins ignored state for one path; dir-only rules skip plain files.
function matchState(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.regex.test(path)) ignored = !r.negated;
  }
  return ignored;
}

// A non-negated rule excluding `innerPath` (and, via the ancestor walk,
// everything under it) from a tree rooted at `outerPath`, or null if inner is
// not nested under outer.
function nestedRelativeIgnorePatterns(outerPath: string, innerPath: string): IgnoreRule[] | null {
  let rel: string | null = null;
  if (outerPath === "") {
    if (innerPath === "") return null;
    rel = innerPath;
  } else if (innerPath.startsWith(outerPath + "/")) {
    rel = innerPath.slice(outerPath.length + 1);
  } else {
    return null;
  }
  return [{ regex: new RegExp(`^${escapeRegex(rel)}$`), negated: false, dirOnly: false }];
}

// A mapping's slice excludes content owned by sibling mappings nested under it
// (e.g. primary at "" with a sibling at "src/common").
export function computeAutoIgnorePatterns(
  pair: SyncPair,
): { a: IgnoreRule[]; b: IgnoreRule[] }[] {
  return pair.mappings.map(m => {
    const a: IgnoreRule[] = [];
    const b: IgnoreRule[] = [];
    for (const sibling of pair.mappings) {
      if (sibling === m) continue;
      const aPats = nestedRelativeIgnorePatterns(m.a, sibling.a);
      if (aPats) a.push(...aPats);
      const bPats = nestedRelativeIgnorePatterns(m.b, sibling.b);
      if (bPats) b.push(...bPats);
    }
    return { a, b };
  });
}

// Always strip .shadowignore files themselves from the synced tree — they're
// source-side metadata for shadow-sync, never replayed onto the target.
const SHADOWIGNORE_SELF_RE = /^(?:.*\/)?\.shadowignore$/;

// The .shadowignore rules governing `dir` at this snapshot: every ancestor file
// from the repo root down to `dir`, plus every nested file at or below it
// (patterns can evolve through history). User file rules come first; the
// self-strip is appended last as a non-negated rule so a user `!` can never
// re-include .shadowignore files into the replayed tree. Auto-ignore is NOT
// here — owner-routing makes it redundant on the diff-overlay, and
// spliceMappings adds it where it is load-bearing.
function readShadowIgnorePatterns(
  commitHash: string,
  dir: string,
  parentHash?: string,
): IgnoreRule[] {
  return [
    ...readShadowIgnoreFilePatterns(commitHash, dir, parentHash),
    { regex: SHADOWIGNORE_SELF_RE, negated: false, dirOnly: false },
  ];
}

// Per-mapping source-side ignore rules at a source commit; parentHash enables
// the static-history fast path in readShadowIgnoreFilePatterns.
function sourceIgnoreByIdx(dc: DirectionConfig, commitHash: string, parentHash?: string): IgnoreRule[][] {
  return dc.mappings.map(m => readShadowIgnorePatterns(commitHash, m.source, parentHash));
}

// Per-mapping target-side ignore rules read from the base tree being built on,
// so they evolve per target branch. Symmetric with sourceIgnoreByIdx.
function targetIgnoreByIdx(dc: DirectionConfig, baseTree: string): IgnoreRule[][] {
  return dc.mappings.map(m => readShadowIgnorePatterns(baseTree, m.target));
}

// Memo of file-derived patterns per (commit-or-tree, mapping-root). Git objects
// are immutable, so a hit is always valid for the run — no invalidation needed.
const shadowIgnoreFileCache = new Map<string, IgnoreRule[]>();

// Exact paths of every .shadowignore from the repo root down to the mapping root.
function ancestorIgnorePaths(sourceDir: string): string[] {
  const out: string[] = [];
  if (sourceDir) {
    const parts = sourceDir.split("/");
    for (let i = parts.length - 1; i > 0; i--) out.push(`${parts.slice(0, i).join("/")}/.shadowignore`);
  }
  out.push(".shadowignore");
  return out;
}

// Cheap (O(changes)) check: did any .shadowignore governing `sourceDir` change
// between parent and commit? Scans the tree diff, not the whole subtree.
function shadowIgnoreChangedVsParent(parentHash: string, commitHash: string, sourceDir: string): boolean {
  const args = ["diff-tree", "-r", "-z", "--name-only", "--no-commit-id", parentHash, commitHash];
  if (sourceDir) args.push("--", `${sourceDir}/`, ...ancestorIgnorePaths(sourceDir));
  const res = git(args, { safe: true, raw: true });
  if (!res.ok) return true;  // fail safe: assume changed → full discovery
  for (const p of (res.stdout ?? "").split("\0")) if (p && SHADOWIGNORE_SELF_RE.test(p)) return true;
  return false;
}

// Discover + compile every .shadowignore governing `sourceDir` at this snapshot.
function readShadowIgnoreFilePatterns(commitHash: string, sourceDir: string, parentHash?: string): IgnoreRule[] {
  const cacheKey = `${commitHash}\0${sourceDir}`;
  const cached = shadowIgnoreFileCache.get(cacheKey);
  if (cached) return cached;

  // Static-history fast path: if no governing .shadowignore changed vs the
  // parent, inherit its patterns instead of walking the tree. The parent is
  // resolved before the child in topo order, so this is normally a cache hit.
  if (parentHash && !shadowIgnoreChangedVsParent(parentHash, commitHash, sourceDir)) {
    const inherited = readShadowIgnoreFilePatterns(parentHash, sourceDir);
    shadowIgnoreFileCache.set(cacheKey, inherited);
    return inherited;
  }

  const found: string[] = [];

  // Ancestors above the mapping root, up to the repo root: one exact-path probe.
  const ancestorPaths = ancestorIgnorePaths(sourceDir);
  const probe = git(["ls-tree", "-z", commitHash, ...ancestorPaths], { safe: true, raw: true });
  if (probe.ok && probe.stdout) {
    for (const entry of probe.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab >= 0) found.push(entry.slice(tab + 1));
    }
  }

  // The mapping root and everything below it: one recursive scan, filtered to
  // .shadowignore by basename.
  const lsArgs = ["ls-tree", "-r", "-z", "--name-only", commitHash];
  if (sourceDir) lsArgs.push("--", `${sourceDir}/`);
  const sub = git(lsArgs, { safe: true, raw: true });
  if (sub.ok && sub.stdout) {
    for (const p of sub.stdout.split("\0")) if (p && SHADOWIGNORE_SELF_RE.test(p)) found.push(p);
  }

  const patterns: IgnoreRule[] = [];
  for (const ignorePath of [...new Set(found)]) {
    const dir = ignorePath === ".shadowignore" ? "" : ignorePath.slice(0, -"/.shadowignore".length);
    const res = git(["show", `${commitHash}:${ignorePath}`], { safe: true });
    if (!res.ok || !res.stdout) continue;
    for (const raw of res.stdout.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))) {
      const compiled = compileShadowIgnoreLine(raw, dir, sourceDir);
      if (compiled) patterns.push(compiled);
    }
  }
  shadowIgnoreFileCache.set(cacheKey, patterns);
  return patterns;
}

// Compile a single .shadowignore line per gitignore semantics, translated
// from `ignoreDir`-relative paths into `sourceDir`-relative paths (the space
// matched by routeSourcePath / filterTreeByIgnore). `ignoreDir` may sit above
// the mapping root (ancestor file), at it, or below it (nested file).
//
// `!` is a negated (re-include) rule; a trailing `/` is dir-only. The compiled
// regex matches the path itself — descendant coverage comes from pathIgnored's
// ancestor walk. Returns null if the pattern targets a sibling subtree outside
// sourceDir.
export function compileShadowIgnoreLine(rawPattern: string, ignoreDir: string, sourceDir: string): IgnoreRule | null {
  let pattern = rawPattern;
  let negated = false;
  if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
  else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);

  let dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  const anchoredToIgnoreDir = pattern.startsWith("/");
  if (anchoredToIgnoreDir) pattern = pattern.slice(1);

  const isAnchored = anchoredToIgnoreDir || pattern.includes("/");

  // Subtree (sourceDir-relative) a nested file's patterns are confined to.
  let confineDir = "";
  let translated = pattern;

  if (ignoreDir === sourceDir) {
    // Mapping-root file: already in the matched space.
  } else if (ignoreDir === "" || sourceDir.startsWith(`${ignoreDir}/`)) {
    // Ancestor file: rebase an anchored pattern down into the mapping.
    if (isAnchored) {
      const relDir = ignoreDir ? sourceDir.slice(ignoreDir.length + 1) : sourceDir;
      if (pattern === relDir) {
        // Pattern points at sourceDir itself; means the whole mapping.
        if (!dirOnly) return null;
        translated = "**";
        dirOnly = false;
      } else if (pattern.startsWith(`${relDir}/`)) {
        translated = pattern.slice(relDir.length + 1);
      } else {
        return null;   // targets a sibling subtree outside the mapping
      }
    }
    // Bare name: matches basename at any depth → unchanged.
  } else {
    // Nested file below the mapping root: confine matches to its subtree.
    confineDir = sourceDir ? ignoreDir.slice(sourceDir.length + 1) : ignoreDir;
  }

  const regex = globToRegexSource(translated);
  const confine = confineDir ? `${escapeRegex(confineDir)}/` : "";
  const prefix = confineDir
    ? (isAnchored ? `^${confine}` : `^${confine}(.*/)?`)
    : (isAnchored ? "^" : "(^|.*/)");
  return { regex: new RegExp(`${prefix}${regex}$`), negated, dirOnly };
}

// Translate a glob into an unanchored regex source fragment, per gitignore:
// `*` stays within a path segment, `**` crosses segments, `?` is one non-slash
// char, `[...]` is a character class (leading `!` negates, leading `]` literal),
// `\x` escapes. Callers add their own anchoring/prefix/suffix.
function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(.*/)?"; } else out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "";
      if (glob[j] === "!") { cls = "^"; j++; }
      if (glob[j] === "]") { cls += "\\]"; j++; }
      const close = glob.indexOf("]", j);
      if (close < 0) {
        out += "\\[";   // unterminated class → literal
      } else {
        out += `[${cls}${glob.slice(j, close)}]`;
        i = close;
      }
    } else if (c === "\\") {
      const next = glob[i + 1];
      if (next !== undefined) { out += escapeRegex(next); i++; } else out += "\\\\";
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

/** Compile a glob pattern (supports * and ** globs) into an anchored regex. */
export function compileIgnorePattern(pattern: string): RegExp {
  return new RegExp(`^${globToRegexSource(pattern)}$`);
}

// ── Branch filters ────────────────────────────────────────────────────────────

interface BranchFilterDoc { filters?: Record<string, string[]>; }

const BRANCH_FILTERS_PATH = path.join(path.dirname(CONFIG_PATH), "branch-filters.json");

/**
 * Required allowlist: missing file = empty map = zero branches synced.
 * The filter is the explicit declaration of what the operator wants synced;
 * silently falling through to "sync everything" defeats the safety the
 * allowlist provides.
 */
function loadBranchFilters(): Map<string, RegExp[]> {
  if (!fs.existsSync(BRANCH_FILTERS_PATH)) return new Map();
  const doc = parseJsonFile<BranchFilterDoc>(BRANCH_FILTERS_PATH);
  const out = new Map<string, RegExp[]>();
  for (const [remote, patterns] of Object.entries(doc.filters ?? {})) {
    out.set(remote, (patterns ?? []).map(compileIgnorePattern));
  }
  return out;
}

let _branchFilters: Map<string, RegExp[]> = loadBranchFilters();
if (_branchFilters.size === 0) {
  console.error(`  ${fs.existsSync(BRANCH_FILTERS_PATH) ? "branch-filters.json is empty" : "branch-filters.json not present"} — no branches will be synced.`);
}

export function filterBranchesForRemote(remote: string, branches: string[]): string[] {
  const patterns = _branchFilters.get(remote);
  if (patterns === undefined) return [];
  return branches.filter(b => patterns.some(re => re.test(b)));
}

/** Test hook — installs an in-memory filter map. `null` resets to empty (zero branches). */
export function setBranchFiltersForTesting(map: Map<string, RegExp[]> | null): void {
  _branchFilters = map ?? new Map();
}

// ── Tree composition ──────────────────────────────────────────────

/**
 * Apply this commit's diff (vs first parent) to parentTree, composed across
 * all of the pair's source→target mappings. Root commits become additions of
 * every file under every source dir.
 */
function buildReplayedTree(opts: {
  commitHash: string;
  sourceFirstParent: string | null;
  dc: DirectionConfig;
  parentTree: string | null;
  tmpIndex: string;
  shadowIgnorePatternsBySourceIdx: IgnoreRule[][];
}): string | null {
  const { commitHash, sourceFirstParent, dc, parentTree, tmpIndex, shadowIgnorePatternsBySourceIdx } = opts;
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };

  if (parentTree) {
    git(["read-tree", parentTree], { env: idxEnv });
  } else {
    git(["read-tree", "--empty"], { env: idxEnv });
  }

  // sourceFirstParent null = source root, which lists as all-additions below.
  let entries: DiffEntry[];

  if (sourceFirstParent) {
    const diff = diffSyncedDirs(sourceFirstParent, commitHash, dc);
    if (!diff.ok) fail(`diff-tree failed for ${commitHash}: ${diff.stderr}`);
    entries = diff.entries;
  } else {
    // No parent to diff against — every ls-tree blob is an addition.
    const lsArgs = ["ls-tree", "-r", "-z", commitHash];
    if (!anyRootSource(dc)) lsArgs.push("--", ...sourceDirsOf(dc).map(d => `${d}/`));
    const lsResult = git(lsArgs, { safe: true, raw: true });
    if (!lsResult.ok || !lsResult.stdout) return null;
    entries = [];
    for (const rec of lsResult.stdout.split("\0")) {
      const tab = rec.indexOf("\t");
      const m = tab > 0 ? rec.slice(0, tab).match(/^(\d+) \w+ ([0-9a-f]+)$/) : null;
      if (m) entries.push({ newMode: m[1], newHash: m[2], status: "A", filePath: rec.slice(tab + 1) });
    }
  }

  if (entries.length === 0) return parentTree ?? null;

  // Target-side .shadowignore, read from the base tree we're building on, so
  // its rules evolve per target branch just like the source side does per
  // source commit. Unioned with the source patterns in routeSourcePath; blocks
  // incoming changes only (the diff overlay), never purging the base.
  const shadowIgnorePatternsByTargetIdx: IgnoreRule[][] = parentTree
    ? targetIgnoreByIdx(dc, parentTree)
    : [];

  // No -M/-C, so renames surface as D+A — we only handle A/M/D/T.
  const removals: string[] = [];
  const additions: string[] = [];   // "mode hash\tpath" lines for --index-info
  for (const e of entries) {
    const targetPath = routeSourcePath(e.filePath, dc, shadowIgnorePatternsBySourceIdx, shadowIgnorePatternsByTargetIdx);
    if (targetPath === null) continue;

    if (e.status === "D") {
      removals.push(targetPath);
    } else {
      additions.push(`${e.newMode} ${e.newHash}\t${targetPath}`);
    }
  }

  applyIndexInfo(idxEnv, removals, additions);

  return git(["write-tree"], { env: idxEnv });
}

const NULL_SHA = "0".repeat(40);

/** Build a tree from `refOrTree` with every `subdirs[i]/` stripped — the "outer" slice. */
function outerOnlyTree(refOrTree: string, subdirs: string[]): string {
  const nonRoot = subdirs.filter(d => d !== "");
  if (nonRoot.length === 0) {
    // All-root means the outer is empty.
    const res = git(["mktree"], { input: "" });
    return res;
  }
  return withTmpIndex("outer", idxEnv => {
    git(["read-tree", refOrTree], { env: idxEnv });
    git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--", ...nonRoot], { env: idxEnv, safe: true });
    return git(["write-tree"], { env: idxEnv });
  });
}

/** Splice each `slices[i].content` into `baseTree` at `slices[i].subdir`. */
function composeSubtrees(baseTree: string, slices: Array<{ subdir: string; content: string }>): string {
  const rootSlice = slices.find(s => s.subdir === "");
  const nonRoot = slices.filter(s => s.subdir !== "");
  return withTmpIndex("compose", idxEnv => {
    // Establish base: the root slice wins wholesale if present; otherwise the
    // caller-supplied baseTree.
    if (rootSlice) {
      git(["read-tree", rootSlice.content], { env: idxEnv });
    } else {
      git(["read-tree", baseTree], { env: idxEnv });
    }
    // Strip every non-root subdir from the base before splicing in the
    // mapping-specific content, so read-tree --prefix can populate cleanly.
    if (nonRoot.length > 0) {
      git(["rm", "-rf", "--cached", "-q", "--ignore-unmatch", "--",
        ...nonRoot.map(s => s.subdir)], { env: idxEnv, safe: true });
      for (const s of nonRoot) {
        git(["read-tree", `--prefix=${s.subdir}/`, s.content], { env: idxEnv });
      }
    }
    return git(["write-tree"], { env: idxEnv });
  });
}

/** Return a new tree SHA equal to `treeSha` minus every path ignored by
 *  `rules` (paths are tested relative to the tree root). When there are no
 *  rules, returns `treeSha` unchanged so the splice is a no-op. */
function filterTreeByIgnore(treeSha: string, rules: IgnoreRule[]): string {
  if (rules.length === 0) return treeSha;
  return withTmpIndex("autoignore", idxEnv => {
    const readRes = git(["read-tree", treeSha], { env: idxEnv, safe: true });
    if (!readRes.ok) return treeSha;
    const ls = git(["ls-files", "-z"], { env: idxEnv, safe: true, raw: true });
    if (ls.ok && ls.stdout) {
      const toRemove = ls.stdout.split("\0").filter(Boolean)
        .filter(p => pathIgnored(rules, p));
      // stdin-based delete (see applyIndexInfo) — avoids argv overflow on Windows.
      applyIndexInfo(idxEnv, toRemove, []);
    }
    return git(["write-tree"], { env: idxEnv });
  });
}

/** For each mapping, read `<fromHash>:<m[side]>`, strip it through the side's
 *  auto-ignore (so sibling-owned nested content doesn't bleed in) plus the
 *  per-commit file/self rules when supplied (round-trip source splice), then
 *  splice into `base` at `m.target`.
 *  Returns null if a root slice fails to resolve — caller decides fallback vs halt. */
function spliceMappings(
  base: string,
  fromHash: string,
  side: "source" | "target",
  dc: DirectionConfig,
  fileSelfRulesByIdx?: IgnoreRule[][],
): string | null {
  const autoPatterns = side === "source" ? dc.autoIgnoreBySourceIdx : dc.autoIgnoreByTargetIdx;
  const slices: Array<{ subdir: string; content: string }> = [];
  for (let i = 0; i < dc.mappings.length; i++) {
    const m = dc.mappings[i];
    const sub = m[side];
    const ref = sub ? `${fromHash}:${sub}` : `${fromHash}^{tree}`;
    const res = git(["rev-parse", ref], { safe: true });
    if (!res.ok) {
      // The mapped dir doesn't exist at this commit
      if (!sub) return null;
      slices.push({ subdir: m.target, content: emptyTreeSha() });
      continue;
    }
    // Auto-ignore always applies here (no owner-routing in a whole-subtree
    // read, so a sibling's nested content would otherwise bleed in). The
    // round-trip source splice also passes the per-commit file + self rules.
    // Self and auto match disjoint path sets, so appending auto after the
    // file/self rules preserves "auto/self outrank a user `!`" precedence.
    const patterns = [...(fileSelfRulesByIdx?.[i] ?? []), ...(autoPatterns[i] ?? [])];
    const filtered = filterTreeByIgnore(res.stdout, patterns);
    slices.push({ subdir: m.target, content: filtered });
  }
  return composeSubtrees(base, slices);
}


/** First mapped parent's full tree. Unreadable means repo corruption, not an
 *  operator-resolvable conflict — abort the run rather than halt one branch. */
function firstParentTree(mappedParents: string[], commitShort: string): string {
  const treeRes = git(["rev-parse", `${mappedParents[0]}^{tree}`], { safe: true });
  if (!treeRes.ok || !treeRes.stdout) fail(`Cannot read tree of mapped parent ${mappedParents[0]} for ${commitShort}.`);
  return treeRes.stdout;
}

/**
 * Reconcile the OUTER across ≥2 mapped parents (the caller splices the first
 * parent's inner over the result). 2 parents + clean merge-tree → auto-merged
 * outer; otherwise all parents must agree on outer — the source commit's scope
 * can't author an outer difference, so disagreement halts.
 */
function reconcileOuter(mappedParents: string[], dc: DirectionConfig): ComposeResult {
  const targetDirs = targetDirsOf(dc);
  if (mappedParents.length === 2) {
    const mergeRes = git(["merge-tree", "--write-tree", mappedParents[0], mappedParents[1]], { safe: true });
    // Clean auto-merge prints just the tree SHA; a conflict prints a multiline
    // body, so the full-string match fails and we fall through to agreement.
    if (mergeRes.ok && /^[0-9a-f]{40}$/.test(mergeRes.stdout)) {
      return { tree: outerOnlyTree(mergeRes.stdout, targetDirs) };
    }
  }
  const outers = mappedParents.map(p => outerOnlyTree(p, targetDirs));
  if (outers.every(o => o === outers[0])) return { tree: outers[0] };
  return { halt: "outer-divergence" };
}

/**
 * Echo splice: when a source parent already round-tripped, the base must carry
 * the target's outer state from that echo, not a frozen bootstrap snapshot.
 * Round-trip (the echo target is itself a mapped parent): splice the CURRENT
 * commit's source-side inner (the operator's resolution) over the echo'd outer;
 * otherwise splice the first parent's inner. Multi-echo outers must agree.
 */
function resolveEcho(
  commit: TopoCommit,
  mappedParents: string[],
  syncedShaMap: Map<string, string>,
  dc: DirectionConfig,
  shadowIgnoreBySourceIdx: IgnoreRule[][],
): ComposeResult | "not-an-echo" {
  const echoKey = targetTrailerKey(dc);
  const echoTargets: string[] = [];
  for (const sourceParent of commit.parents) {
    const parentMeta = getCommitMeta(sourceParent);
    if (hasTrailer(parentMeta.trailers, echoKey)) {
      const mapped = syncedShaMap.get(sourceParent);
      if (mapped) echoTargets.push(mapped);
    }
  }
  if (echoTargets.length === 0) return "not-an-echo";

  if (echoTargets.length > 1) {
    const outers = echoTargets.map(t => outerOnlyTree(t, targetDirsOf(dc)));
    if (!outers.every(o => o === outers[0])) return { halt: "multi-echo-disagreement" };
  }

  const echoTargetSHA = echoTargets[0];
  const echoTreeRes = git(["rev-parse", `${echoTargetSHA}^{tree}`], { safe: true });
  if (!echoTreeRes.ok) return { halt: "missing-tree" };

  // Round-trip splices the commit's OWN source tree (fresh, unfiltered), so
  // apply .shadowignore here — buildReplayedTree's diff overlay only filters
  // changed paths and would let a base-borne ignored file survive otherwise.
  const spliced = mappedParents.includes(echoTargetSHA)
    ? spliceMappings(echoTreeRes.stdout, commit.hash, "source", dc, shadowIgnoreBySourceIdx)
    : spliceMappings(echoTreeRes.stdout, mappedParents[0], "target", dc);
  return spliced === null ? { halt: "missing-tree" } : { tree: spliced };
}

/**
 * Base tree for replaying `commit` onto `mappedParents`. Invariant: inner =
 * the FIRST PARENT's inner, outer = the reconciled outer; the one exception
 * is an echo round-trip, where resolveEcho splices the commit's own resolved
 * source. Why first parent: buildReplayedTree overlays diff(firstParent →
 * commit) as an ABSOLUTE apply, so any other inner (e.g. auto-merged)
 * silently survives where the diff is empty, dropping resolutions that
 * re-assert the first parent.
 */
function composeMergeBaseTree(opts: {
  commit: TopoCommit;
  mappedParents: string[];
  syncedShaMap: Map<string, string>;
  dc: DirectionConfig;
  shadowIgnoreBySourceIdx: IgnoreRule[][];
}): ComposeResult {
  const { commit, mappedParents, syncedShaMap, dc, shadowIgnoreBySourceIdx } = opts;
  const commitShort = commit.hash.slice(0, 8);
  const confined = allTargetsConfined(dc);

  // Echo splice runs first, regardless of confinement: an unmapped source
  // parent resolves to targetInit, whose stale outer would otherwise leak
  // through the first-parent shortcuts below verbatim.
  const echo = resolveEcho(commit, mappedParents, syncedShaMap, dc, shadowIgnoreBySourceIdx);
  if (echo !== "not-an-echo") return echo;

  // 1 parent: outer can't have diverged; inner is that parent's. (fast path)
  if (mappedParents.length === 1) return { tree: firstParentTree(mappedParents, commitShort) };

  // Same-repo: the synced region is the whole tree, so the first parent's tree
  // is the correct base verbatim.
  if (!confined) return { tree: firstParentTree(mappedParents, commitShort) };

  // Cross-repo, ≥2 parents: reconcile the outer, splice first parent's inner.
  const outer = reconcileOuter(mappedParents, dc);
  if (isHalt(outer)) return outer;
  const spliced = spliceMappings(outer.tree, mappedParents[0], "target", dc);
  return spliced === null ? { halt: "missing-tree" } : { tree: spliced };
}

// ── Ancestry resolution ──────────────────────────────────────────────────────


/** For parents outside the sync's scope, anchor to the newest replayed ancestor. */
function findEchoAnchor(graph: SourceGraph, parentHash: string, syncedShaMap: Map<string, string>): string | null {
  const h = firstParentUntil(graph, parentHash, x => syncedShaMap.has(x));
  return h ? syncedShaMap.get(h)! : null;
}

// True iff `ancestor` is an ancestor of (or equals) `descendant` on the source
// side. Missing objects read as not-an-ancestor — fail closed toward halting.
function isSourceAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { safe: true }).ok;
}

interface ResolvedParents {
  parents: string[];
  /** Set when a parent's only counterparts are squash-absorbed on lineages
   *  this commit doesn't descend from — the caller halts. */
  foreignAbsorbed?: { parent: string; entries: AbsorbedEntry[] };
}

/**
 * Find target side parent from source side hash:
 * 1. parent recorded in syncedShaMap (direct replay)
 * 2. parent is in a Halt state (substitute its anchors)
 * 3. parent squash-absorbed: its squash stands in only if this commit
 *    descends from the absorber; foreign lineages halt instead
 * 4. unknown parents replaced by echo anchor or root
 */
function resolveHaltAwareParents(
  commit: TopoCommit,
  graph: SourceGraph,
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
  targetInit: string | null,
  haltedSources: Set<string>,
  haltRecords: Map<string, HaltRecord>,
): ResolvedParents {
  if (commit.parents.length === 0) {
    return { parents: targetInit ? [targetInit] : [] };
  }
  const parents: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (sha: string | null | undefined) => {
    if (sha && !seen.has(sha)) { parents.push(sha); seen.add(sha); }
  };
  for (const parentHash of commit.parents) {
    const haltAnchors = haltedSources.has(parentHash)
      ? haltRecords.get(parentHash)?.anchorCommits
      : undefined;
    const absorbedEntries = absorbedMap.get(parentHash);
    if (syncedShaMap.has(parentHash)) {
      pushUnique(syncedShaMap.get(parentHash));
    } else if (haltAnchors && haltAnchors.length > 0) {
      for (const ac of haltAnchors) pushUnique(ac);
    } else if (absorbedEntries && absorbedEntries.length > 0) {
      const valid = absorbedEntries.find(e => isSourceAncestor(e.absorber, commit.hash));
      if (!valid) {
        return { parents, foreignAbsorbed: { parent: parentHash, entries: absorbedEntries } };
      }
      pushUnique(valid.target);
    } else {
      // not mapped, and either not halted or halted without anchors
      pushUnique(findEchoAnchor(graph, parentHash, syncedShaMap) ?? targetInit);
    }
  }
  return { parents };
}

/**
 * Halted unmapped ancestors reachable through the commit's parents — encoded
 * as extra trailers on its replay so later runs treat them as replayed.
 */
function collectAbsorbedHalted(
  commit: TopoCommit,
  haltedSources: Set<string>,
  syncedShaMap: Map<string, string>,
  graph: SourceGraph,
): string[] {
  const absorbed = new Set<string>();
  const seen = new Set<string>();
  const stack = [...commit.parents];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p) || syncedShaMap.has(p)) continue;
    seen.add(p);
    if (!haltedSources.has(p)) continue;
    absorbed.add(p);
    for (const pp of graphParentsOf(graph, p)) stack.push(pp);
  }
  return [...absorbed];
}

/**
 * Source→target SHA mappings from this direction's shadow branches' trailers
 * (`<sourceLabel>-to-<targetLabel>`): first value direct, rest scoped-absorbed.
 */
function loadReplayedMappings(opts: {
  branches: string[];
  dc: DirectionConfig;
}): ScopedMappings {
  const { branches, dc } = opts;
  const candidateRefs = branches.map(b => `${dc.target.remote}/${shadowBranchName(dc.source.label, b)}`);
  const shadowRefs = filterExistingRefs(candidateRefs);

  if (shadowRefs.length === 0) {
    return { direct: new Map(), absorbed: new Map() };
  }
  const replayedKey = sourceTrailerKey(dc);
  return extractTrailerMappings(
    ["log", ...shadowRefs, `--grep=^${replayedKey}`],
    replayedKey,
  );
}

/** Flat source→target view (direct wins; else first absorbed entry) — for
 *  consumers without lineage context (tag sync). Matches pre-scoping behavior. */
function flattenMappings(direct: Map<string, string>, absorbed: AbsorbedMap): Map<string, string> {
  const flat = new Map(direct);
  for (const [src, entries] of absorbed) {
    if (!flat.has(src) && entries.length > 0) flat.set(src, entries[0].target);
  }
  return flat;
}

/** Each branch's shadow tip: the newest faithfully mapped commit on its
 *  first-parent line (the branch HEAD itself may be outer-only and unmapped).
 *  Squash-absorbed counterparts count only on lineages containing their
 *  absorber — a fork stranded behind a foreign squash keeps its last faithful
 *  tip instead of inheriting the squash's tree.
 *
 *  The walk is monotonic: a candidate target is accepted only if it
 *  fast-forwards over the next resolvable commit below it. This rejects an echo
 *  (or rebased echo) whose target DIVERGES from a just-replayed commit beneath
 *  it on the line — anchoring on it would point the shadow at the echo's foreign
 *  target and skip the real replayed lineage. A normal round-trip echo, whose
 *  target legitimately descends from the lineage, is still accepted. */
function mapBranchesToTargetTips(
  graph: SourceGraph,
  remote: string,
  branches: string[],
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
): Map<string, string> {
  const branchMapping = new Map<string, string>();
  for (const branch of branches) {
    const tipRes = git(["rev-parse", `${remote}/${branch}`], { safe: true });
    if (!tipRes.ok || !tipRes.stdout) fail(`Failed to resolve ${remote}/${branch}: ${tipRes.stderr}`);
    const tip = tipRes.stdout.trim();
    // Squash-absorbed counterparts stand in only on lineages containing their absorber.
    const resolve = (hash: string): string | undefined =>
      syncedShaMap.get(hash) ?? absorbedMap.get(hash)?.find(e => isSourceAncestor(e.absorber, tip))?.target;

    let chosen: string | undefined;
    for (let h: string | undefined = tip; h; h = graphParentsOf(graph, h)[0]) {
      const target = resolve(h);
      if (target === undefined) continue;
      if (chosen === undefined) chosen = target;        // newest resolvable: provisional tip
      else if (isSourceAncestor(target, chosen)) break;  // tip fast-forwards over it -> keep tip
      else chosen = target;                              // tip diverged from it -> demote to it
    }
    if (chosen) branchMapping.set(branch, chosen);
  }
  return branchMapping;
}

/**
 * Return the bare branch name on `sourceRemote` containing `commitHash` if
 * unambiguous, else null. Used to point error messages at the right shadow ref.
 */
function inferSourceBranch(commitHash: string, sourceRemote: string): string | null {
  const res = git(
    ["for-each-ref", "--format=%(refname:short)", "--contains", commitHash, `refs/remotes/${sourceRemote}/`],
    { safe: true },
  );
  if (!res.ok || !res.stdout) return null;
  const matches = res.stdout.split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(r => r.startsWith(`${sourceRemote}/`) ? r.slice(sourceRemote.length + 1) : r)
    .filter(b => b && b !== "HEAD");
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Operator diagnostic for a halt. All causes share the header and the
 * hand-built trailer escape hatch; outer-state disagreements additionally get
 * the full round-trip recovery recipe.
 */
function formatHaltDiagnostic(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  dc: DirectionConfig;
  cause: ComposeHaltCause;
}): string {
  const { commit, meta, mappedParents, dc, cause } = opts;
  const { target } = dc;
  const branchLabel = inferSourceBranch(commit.hash, dc.source.remote) ?? "<source-branch>";
  const shadowName = shadowBranchName(dc.source.label, branchLabel);
  const shadowRef = `refs/heads/${shadowName}`;
  const trailer = `${sourceTrailerKey(dc)}: ${commit.hash}`;
  const ppLines = mappedParents.map(p => `    ${p}`).join("\n");

  const failure = HALT_CAUSES[cause].failure(mappedParents, target.remote);

  // outer-divergence and multi-echo-disagreement are both outer-state
  // disagreements the operator resolves the same way (round-trip), so they
  // share the full recipe and the exact "cannot auto-resolve" headline the
  // recovery tests assert. Only missing-tree is structurally different.
  const structural = cause === "missing-tree";
  const lines: string[] = [
    structural
      ? `${meta.short}: cannot compose replay base tree — branch halted.`
      : `${meta.short}: cannot auto-resolve replay parent tree — branch halted.`,
    ``,
    `  ${structural ? "Source commit:  " : "Source merge:   "}${commit.hash}  (${meta.short})`,
    `  Failure:        ${failure}`,
    `  Mapped parents on ${target.remote}:`,
    ppLines,
    ``,
  ];

  if (structural) {
    lines.push(
      `Recovery: create a commit on ${shadowRef} with these mapped parents and a`,
      `tree you choose (resolved outer + merged inner), including this trailer in`,
      `its message body (exact text):`,
      ``,
      `        ${trailer}`,
      ``,
      `On the next sync run, ${meta.short} is picked up via that trailer and skipped.`,
    );
    return lines.join("\n");
  }

  const sourceScopeDirs = sourceDirsOf(dc).filter(d => d !== "");
  const targetScopeDirs = targetDirsOf(dc).filter(d => d !== "");
  const sourceScope = sourceScopeDirs.length > 0 ? sourceScopeDirs.map(d => `${d}/`).join(", ") : "<root>";
  const targetScope = targetScopeDirs.length > 0 ? targetScopeDirs.map(d => `${d}/`).join(", ") : "<root>";
  const shortHash = commit.hash.slice(0, 7);
  const parentArgs = mappedParents.map(p => `-p ${p}`).join(" ");

  lines.push(
    `  Mapped parents disagree on outer state (files outside ${targetScope}). ` +
    `The source commit's scope is ${sourceScope}, so it couldn't have authored this outer-state difference.`,
    ``,
    `Recovery — choose ONE:`,
    ``,
    `  (Recommended) Round-trip + squash.`,
    `    1. Resolve the merge on ${target.remote}'s working branch as you would`,
    `       normally — e.g. \`git checkout ${branchLabel} && git merge --no-ff <from-branch(es)>\`,`,
    `       resolve conflicts, commit (call this Mm), and push. For an octopus`,
    `       source merge with ≥3 mapped parents, merge the corresponding branches`,
    `       sequentially or as a single octopus on ${target.remote}.`,
    `    2. Run shadow-sync in the other direction so Mm is replayed onto`,
    `       ${dc.source.remote}'s shadow ref (\`${shadowName}\`).`,
    `    3. On ${dc.source.remote}, merge that shadow ref into the working branch`,
    `       (\`git merge origin/${shadowName}\`) and push.`,
    `    4. Re-run this sync. The engine absorbs ${meta.short} (and any`,
    `       descendants halted with it) into the resulting merge's replay`,
    `       automatically — no flags needed.`,
    ``,
    `  (Alternative) Hand-built resolution on the shadow ref. Create a commit`,
    `  on ${shadowRef} that`,
    `    - has the divergent mapped parents above as its git parents`,
    `    - has a tree you choose (the resolved outer state + the merged inner state)`,
    `    - includes this trailer in its message body (exact text):`,
    ``,
    `        ${trailer}`,
    ``,
    `  On the next sync run, ${meta.short} will be picked up via that trailer and skipped.`,
    ``,
    `  Suggested commands (run in this repo, with ${target.remote} fetched):`,
    `    git checkout -b manual-resolve-${shortHash} ${mappedParents[0]}`,
    `    git merge --no-ff ${mappedParents.slice(1).join(" ")}`,
    `    # resolve conflicts, stage the result, then:`,
    `    tree=$(git write-tree)`,
    `    new=$(git commit-tree $tree ${parentArgs} \\`,
    `        -m "Manual resolution of ${shortHash}" \\`,
    `        -m "${trailer}")`,
    `    git update-ref ${shadowRef} $new`,
    `    git push ${target.remote} ${shadowRef.replace(/^refs\/heads\//, "")}`,
    `  Then re-run shadow-sync.`,
  );
  return lines.join("\n");
}


// ── Halt branches ──────────────────────────────────────────────────────

/** Per-source-commit halt reason — surfaced to the CLI via mirrorHistory. */
export interface HaltedBranch {
  /** Source branch the halt was discovered on, or null if undetermined. */
  branch: string | null;
  commitSha: string;
  commitShort: string;
  mappedParents: string[];
  diagnostic: string;
}

interface HaltRecord {
  anchorCommits: string[];
  diagnostic: string;
  commitShort: string;
  /** The original halted ancestor this record traces back to. */
  rootHalt?: string;
}

interface ReplayHalts {
  haltedSources: Set<string>;
  haltRecords: Map<string, HaltRecord>;
}

// Operator text per halt cause: `summary` for the one-line log, `failure` for
// the diagnostic's "Failure:" line.
const HALT_CAUSES = {
  "outer-divergence": {
    summary: "outer-state divergence between mapped parents",
    failure: (parents: string[], remote: string) => parents.length === 2
      ? `merge-tree conflict between mapped parents on ${remote}`
      : `octopus merge with ${parents.length} mapped parents on ${remote} (no auto-resolution)`,
  },
  "multi-echo-disagreement": {
    summary: "already-replayed parents disagree on outer state",
    failure: () => "multiple already-replayed (echo) parents disagree on outer state",
  },
  "missing-tree": {
    summary: "a required parent tree or mapped subdirectory was absent",
    failure: () => "a required parent tree or mapped subdirectory was absent during base-tree composition",
  },
};
type ComposeHaltCause = keyof typeof HALT_CAUSES;
interface ComposeHalt { halt: ComposeHaltCause; }
type ComposeResult = { tree: string } | ComposeHalt;

function isHalt(r: ComposeResult): r is ComposeHalt {
  return "halt" in r;
}

// The nearest halt a parent sits behind: walk its first-parent line to the first
// mapped-or-halted commit; return that commit only if it's a halt (unmapped),
// else null. A dropped commit is unmapped-but-not-halted, so it doesn't end the
// walk — the halt of an ancestor masked behind it is still seen.
function haltBehindParent(
  graph: SourceGraph,
  parent: string,
  haltedSources: Set<string>,
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
): string | null {
  const stop = firstParentUntil(graph, parent,
    x => syncedShaMap.has(x) || absorbedMap.has(x) || haltedSources.has(x));
  return stop !== undefined && haltedSources.has(stop) && !syncedShaMap.has(stop) && !absorbedMap.has(stop)
    ? stop : null;
}

// True iff every source-side parent sits behind a halt on its first-parent line
// — a commit with at least one parent reaching a mapping first escapes
// propagation and proceeds to normal replay. Dropped commits don't break the
// chain, so a halt masked behind one still propagates to its kept descendants.
function isHaltPropagated(
  commit: TopoCommit,
  graph: SourceGraph,
  haltedSources: Set<string>,
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
): boolean {
  if (commit.parents.length === 0) return false;
  return commit.parents.every(p => haltBehindParent(graph, p, haltedSources, syncedShaMap, absorbedMap) !== null);
}

/**
 * Record the commit as halted and inherit its halted ancestors' halt reason.
 * Each parent's nearest masked halt (through any dropped commits) supplies the
 * inherited anchors and root, so the linkage survives a dropped intermediary.
 */
function markPropagatedHalt(
  commit: TopoCommit,
  meta: CommitMeta,
  graph: SourceGraph,
  haltedSources: Set<string>,
  haltRecords: Map<string, HaltRecord>,
  syncedShaMap: Map<string, string>,
  absorbedMap: AbsorbedMap,
): void {
  haltedSources.add(commit.hash);
  const inheritedAnchorCommits: string[] = [];
  const seenAnchorCommits = new Set<string>();
  let rootHalt: string | undefined;
  for (const p of commit.parents) {
    const halt = haltBehindParent(graph, p, haltedSources, syncedShaMap, absorbedMap);
    const record = halt ? haltRecords.get(halt) : undefined;
    if (!halt) continue;
    rootHalt = rootHalt ?? record?.rootHalt ?? halt;
    for (const ac of record?.anchorCommits ?? []) {
      if (!seenAnchorCommits.has(ac)) { inheritedAnchorCommits.push(ac); seenAnchorCommits.add(ac); }
    }
  }
  if (inheritedAnchorCommits.length > 0 || rootHalt) {
    haltRecords.set(commit.hash, { anchorCommits: inheritedAnchorCommits, diagnostic: "", commitShort: meta.short, rootHalt });
  }
  console.log(`  Skipping ${meta.short} (descended from halted ancestor).`);
}

/**
 * Record an original halt: neither compose function could produce a defensible
 * parent tree. mappedParents are stored as anchorCommits so that downstream
 * descendants (which escape the halt via a mapped parent) can substitute them
 * via resolveHaltAwareParents.
 */
function haltCommit(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  mappedParents: string[];
  dc: DirectionConfig;
  haltedSources: Set<string>;
  haltRecords: Map<string, HaltRecord>;
  cause: ComposeHaltCause;
}): void {
  const { commit, meta, mappedParents, dc, haltedSources, haltRecords, cause } = opts;
  haltedSources.add(commit.hash);
  haltRecords.set(commit.hash, {
    anchorCommits: mappedParents,
    diagnostic: formatHaltDiagnostic({ commit, meta, mappedParents, dc, cause }),
    commitShort: meta.short,
    rootHalt: commit.hash,
  });
  console.log(`  ⚠ Halted on ${meta.short}: ${HALT_CAUSES[cause].summary}.`);
}

/**
 * Diagnostic for a commit stranded behind a squash-absorbed ancestor: the
 * ancestor's halt was resolved on another lineage, so its squash counterpart
 * is not a faithful replay base here. The recovery merges the resolved
 * branch's SHADOW ref (not the branch itself): the ref carries the resolution
 * echo, and the echo round-trip splice is what preserves this branch's own
 * content during the absorbing replay.
 */
function formatAbsorbedElsewhereDiagnostic(opts: {
  commitSha: string;
  commitShort: string;
  absorbedAncestor: string;
  entries: AbsorbedEntry[];
  dc: DirectionConfig;
}): string {
  const { commitSha, commitShort, absorbedAncestor, entries, dc } = opts;
  const branchLabel = inferSourceBranch(commitSha, dc.source.remote) ?? "<source-branch>";
  const e = entries[0];
  const resolvedBranch = inferSourceBranch(e.absorber, dc.source.remote) ?? "<resolved-branch>";
  const resolvedShadowRef = shadowBranchName(dc.source.label, resolvedBranch);
  const trailer = `${sourceTrailerKey(dc)}: ${commitSha}`;
  return [
    `${commitShort}: ancestor was squash-resolved on another branch — branch halted.`,
    ``,
    `  Source commit:    ${commitSha}  (${commitShort})`,
    `  Halted ancestor:  ${absorbedAncestor}`,
    `  Squash replay:    ${e.target}`,
    `  Resolution at:    ${e.absorber}  (on '${resolvedBranch}')`,
    ``,
    `This branch forked from the halted ancestor before the resolution landed,`,
    `so the squash's tree is not a faithful replay base for it.`,
    ``,
    `Recovery: on ${dc.source.remote}, merge the resolved branch's shadow ref into`,
    `${branchLabel} (the ref carries the resolution echo, which preserves this`,
    `branch's own content during replay):`,
    `    git checkout ${branchLabel}`,
    `    git merge origin/${resolvedShadowRef}`,
    `Then push and re-run this sync — the stranded commits are absorbed into the`,
    `merge's replay automatically.`,
    ``,
    `(Alternative) Hand-build a resolution commit on this branch's shadow ref`,
    `with this trailer in its message body (exact text):`,
    ``,
    `        ${trailer}`,
  ].join("\n");
}

/** Halt a commit whose parent's only replay counterparts are squashes on
 *  foreign lineages. Anchors = the squash targets, so a later recovery merge
 *  (which absorbs this commit) gets the squash as a replay parent. */
function haltAbsorbedElsewhere(opts: {
  commit: TopoCommit;
  meta: CommitMeta;
  foreign: { parent: string; entries: AbsorbedEntry[] };
  dc: DirectionConfig;
  haltedSources: Set<string>;
  haltRecords: Map<string, HaltRecord>;
}): void {
  const { commit, meta, foreign, dc, haltedSources, haltRecords } = opts;
  haltedSources.add(commit.hash);
  haltRecords.set(commit.hash, {
    anchorCommits: foreign.entries.map(e => e.target),
    diagnostic: formatAbsorbedElsewhereDiagnostic({
      commitSha: commit.hash, commitShort: meta.short,
      absorbedAncestor: foreign.parent, entries: foreign.entries, dc,
    }),
    commitShort: meta.short,
    rootHalt: foreign.parent,
  });
  console.log(`  ⚠ Halted on ${meta.short}: ancestor ${foreign.parent.slice(0, 7)} was squash-resolved on another lineage.`);
}


// ── Mirror orchestration ──────────────────────────────────────────────────────

/**
 * Replay newCommits in topo order, mutating `syncedShaMap` so each replay is
 * visible to later parent resolution in the same batch.
 *
 * Halt semantics: a halted commit goes into `haltedSources`, NOT `syncedShaMap`.
 * Commits whose parents are ALL halted+unmapped halt in turn; a commit with
 * at least one mapped parent replays normally and absorbs reachable halted
 * ancestors as extra trailers (already-replayed on the next run).
 */
function replayCommits(opts: {
  newCommits: TopoCommit[];
  syncedShaMap: Map<string, string>;
  absorbedMap: AbsorbedMap;
  targetInit: string | null;
  dc: DirectionConfig;
  graph: SourceGraph;
}): ReplayHalts {
  const { newCommits, syncedShaMap, absorbedMap, targetInit, dc, graph } = opts;
  const replayedKey = sourceTrailerKey(dc);

  const haltedSources = new Set<string>();
  const haltRecords = new Map<string, HaltRecord>();

  withTmpIndex("replay", idxEnv => {
    const tmpIndex = idxEnv.GIT_INDEX_FILE;
    const total = newCommits.length;
    const verbose = total < PROGRESS_THRESHOLD;
    let idx = 0;
    for (const commit of newCommits) {
      idx++;
      if (!verbose) logDecileProgress("Replayed", idx, total);
      const meta = getCommitMeta(commit.hash);

      if (isHaltPropagated(commit, graph, haltedSources, syncedShaMap, absorbedMap)) {
        markPropagatedHalt(commit, meta, graph, haltedSources, haltRecords, syncedShaMap, absorbedMap);
        continue;
      }

      // Carries our OWN replay trailer → a cherry-pick (git copies the message
      // verbatim) of a commit we already replayed. Still replay it — the pick may
      // re-introduce content the target no longer has — but strip the copied
      // trailer so it isn't duplicated on the re-emitted commit.
      const isCherryPickedCopy = hasTrailer(meta.trailers, replayedKey);

      if (verbose) {
        if (isCherryPickedCopy) {
          console.log(`  [${idx}/${total}] Replaying ${meta.short} (cherry-picked copy of an already-replayed commit).`);
        } else {
          const label = commit.parents.length > 1
            ? `merge commit ${meta.short}`
            : commit.parents.length === 0
              ? `root commit ${meta.short}`
              : meta.short;
          console.log(`  [${idx}/${total}] Replaying ${label}...`);
        }
      }

      // Resolve parent from trailers or Halt anchors for squash fix
      const resolved = resolveHaltAwareParents(commit, graph, syncedShaMap, absorbedMap, targetInit, haltedSources, haltRecords);
      if (resolved.foreignAbsorbed) {
        haltAbsorbedElsewhere({ commit, meta, foreign: resolved.foreignAbsorbed, dc, haltedSources, haltRecords });
        continue;
      }
      const mappedParents = resolved.parents;

      // Per-mapping source ignore (file rules + self). Computed before the base
      // tree so composeMergeBaseTree can filter the round-trip source splice —
      // the one place fresh, unfiltered source enters the base. spliceMappings
      // re-adds auto-ignore there; the diff overlay relies on owner-routing.
      const shadowIgnoreBySourceIdx = sourceIgnoreByIdx(dc, commit.hash, commit.parents[0]);

      let parentTree: string | null;
      if (mappedParents.length === 0) {
        if (commit.parents.length !== 0) fail(`Non-root commit ${meta.short} has no resolvable parent tree.`);
        // Source root with no targetInit — buildReplayedTree handles null via read-tree --empty.
        parentTree = null;
      } else {
        const composed = composeMergeBaseTree({ commit, mappedParents, syncedShaMap, dc, shadowIgnoreBySourceIdx });
        if (isHalt(composed)) {
          // No compose path produced a defensible tree. Halt the branch (other
          // branches in this call keep flowing); the diagnostic surfaces via
          // mirrorHistory's return.
          haltCommit({ commit, meta, mappedParents, dc, haltedSources, haltRecords, cause: composed.halt });
          continue;
        }
        parentTree = composed.tree;
      }

      // Diff against the source first parent only when its mapping is real.
      // An orphan parent (targetInit fallback) has no synced history to diff
      // against, so the commit replays its full slice via the root path.
      const useSourceParent = commit.parents.length > 0 && mappedParents[0] !== targetInit;

      const tree = buildReplayedTree({
        commitHash: commit.hash,
        sourceFirstParent: useSourceParent ? commit.parents[0] : null,
        dc,
        parentTree,
        tmpIndex,
        shadowIgnorePatternsBySourceIdx: shadowIgnoreBySourceIdx,
      });

      if (!tree) {
        if (verbose) console.log(`  Skipping ${meta.short} (source content missing).`);
        continue;
      }

      const absorbed = collectAbsorbedHalted(commit, haltedSources, syncedShaMap, graph);

      // One trailer; value lists the direct counterpart first, absorbed next.
      const trailerValue = [commit.hash, ...absorbed].join(" ");
      const base = isCherryPickedCopy ? stripReplayedTrailers(meta.message, dc) : meta.message;
      const msg = appendTrailer(base, `${replayedKey}: ${trailerValue}`);

      const parentArgs = mappedParents.flatMap(p => ["-p", p]);
      // Message over stdin — a >32KB message as argv overflows CreateProcess on Windows.
      const newSHA = git(["commit-tree", tree, ...parentArgs], {
        env: buildCommitEnv(meta, dc.identityByEmail), input: msg,
      });

      syncedShaMap.set(commit.hash, newSHA);
      for (const sha of absorbed) {
        // Scoped, not direct: the squash stands in for the absorbed commit
        // only on lineages containing this commit (the absorber). Stranded
        // forks keep their propagated halt records and surface via rootHalt.
        const list = absorbedMap.get(sha) ?? [];
        list.push({ target: newSHA, absorber: commit.hash });
        absorbedMap.set(sha, list);
        haltedSources.delete(sha);
        haltRecords.delete(sha);
      }
      if (absorbed.length > 0) {
        console.log(`  ✓ Replayed${isCherryPickedCopy ? " (cherry-picked copy)" : ""}, absorbing ${absorbed.length} halted ancestor(s): ${absorbed.map(s => s.slice(0, 7)).join(", ")}.`);
      } else if (verbose) {
        console.log(isCherryPickedCopy ? "  ✓ Replayed (cherry-picked copy)." : "  ✓ Replayed.");
      }
    }
  });

  return { haltedSources, haltRecords };
}

/** Replay one side of a pair onto the other; `from` selects the source. */
export function mirrorHistory(opts: {
  pair: SyncPair;
  from: "a" | "b";
  branches: string[];
  allowManyCommits?: boolean;
  allowLargeCommits?: boolean;
}): {
  mirrored: number;
  branchMapping: Map<string, string>;
  syncedShaMap: Map<string, string>;
  upToDate: boolean;
  haltedBranches: HaltedBranch[];
} {
  const { pair, from, branches, allowManyCommits, allowLargeCommits } = opts;
  const dc = buildDirectionConfig(pair, from);

  // One in-memory source graph (two batched git calls).
  const graph = collectSourceGraph(dc, branches);
  const sourceCommits = deriveSourceCommits(graph);

  console.log("Scanning history for already-replayed commits...");
  // Synced: already replayed (source origin) + echo (target origin) with trailer
  const { direct: syncedShaMap, absorbed: absorbedMap } = loadReplayedMappings({ branches, dc });
  console.log(`Found ${syncedShaMap.size} previously replayed commit(s)${absorbedMap.size > 0 ? ` (+${absorbedMap.size} squash-absorbed)` : ""}.`);
  // Settled from DIRECT replays only (pre-echo): the frontier's "ancestry already
  // has a verdict" guarantee holds only for commits a prior same-from sync actually
  // replayed. Echoes enter via the reverse direction and carry no such guarantee —
  // a genuine commit beneath an echo on the first-parent line would be wrongly
  // settled-dropped. Must run before addEchoMappings mixes echoes into the map.
  const settledSourceHash = computeSettledCommits(graph, branches, dc, syncedShaMap, absorbedMap);
  addEchoMappings(sourceCommits, dc, syncedShaMap);
  const syncedSourceHash = new Set([...syncedShaMap.keys(), ...absorbedMap.keys()]);
  let newToScan = 0, settledDropped = 0;
  for (const c of sourceCommits) {
    if (syncedSourceHash.has(c.hash)) continue;
    if (settledSourceHash.has(c.hash)) settledDropped++; else newToScan++;
  }
  console.log(`Scanning ${newToScan} new source commit(s) since last replay for load-bearing changes (${sourceCommits.length} reachable; skipping ${syncedSourceHash.size} already replayed/echo, ${settledDropped} settled-dropped)...`);
  const newCommits = dropNonLoadBearingCommits(sourceCommits, dc, syncedSourceHash, settledSourceHash);
  console.log(`${newCommits.length} new load-bearing commit(s).`);

  if (newCommits.length === 0) {
    return {
      mirrored: 0,
      branchMapping: mapBranchesToTargetTips(graph, dc.source.remote, branches, syncedShaMap, absorbedMap),
      syncedShaMap: flattenMappings(syncedShaMap, absorbedMap),
      upToDate: true,
      haltedBranches: [],
    };
  }

  console.log(`Found ${newCommits.length} new commit(s) to replay.\n`);

  // Safety gates — fail closed before any local replay/push work. Each names
  // its override flag so the operator opts in deliberately.
  //
  // A branch with no shadow ref yet is being synced for the first time — adding
  // it to the filter is the deliberate act, so its backlog is intentional. Once
  // some branch is established, gate only commits reachable from established
  // branches; a first-time branch's history is exempt (and logged), while an
  // accidental push to an established branch still fails closed. The very first
  // bootstrap (nothing established) gates everything, as before.
  const establishedBranches = branches.filter(b =>
    refExists(`${dc.target.remote}/${shadowBranchName(dc.source.label, b)}`));
  let gatedCommits = newCommits;
  if (establishedBranches.length > 0 && establishedBranches.length < branches.length) {
    const tips = establishedBranches
      .map(b => git(["rev-parse", `${dc.source.remote}/${b}`], { safe: true }))
      .filter(r => r.ok && r.stdout).map(r => r.stdout.trim());
    const reachable = collectReachable(graph, tips);
    gatedCommits = newCommits.filter(c => reachable.has(c.hash));
    const exempt = newCommits.length - gatedCommits.length;
    if (exempt > 0) {
      const newBranches = branches.filter(b => !establishedBranches.includes(b));
      console.log(`Exempting ${exempt} commit(s) on ${newBranches.length} newly-added branch(es) from the commit-count limit: ${newBranches.join(", ")}.`);
    }
  }
  if (!allowManyCommits && gatedCommits.length > MAX_COMMITS_PER_SYNC) {
    fail(`${gatedCommits.length} commits to replay exceeds the safety limit of ${MAX_COMMITS_PER_SYNC}. ` +
      `Re-run with --allow-many-commits to override (or raise maxCommitsPerSync in the config).`);
  }
  if (!allowLargeCommits) {
    const bytes = commitReplayedBytes(newCommits, dc);
    const oversized = newCommits.filter(c => (bytes.get(c.hash) ?? 0) > MAX_COMMIT_BYTES);
    if (oversized.length > 0) {
      const list = oversized
        .map(c => `  ${c.hash.slice(0, 9)}  ${humanBytes(bytes.get(c.hash) ?? 0)}`)
        .join("\n");
      fail(`${oversized.length} commit(s) replay more than ${humanBytes(MAX_COMMIT_BYTES)} of content:\n${list}\n` +
        `Re-run with --allow-large-commits to override, .shadowignore the oversized path(s) to ` +
        `exclude them, or raise maxCommitBytes in the config.`);
    }
  }

  // Fallback root for orphan parents (see resolveHaltAwareParents).
  const anchorBranch = dc.target.anchorBranch ?? "main";
  let targetInit: string | null = null;
  if (refExists(`${dc.target.remote}/${anchorBranch}`)) {
    const initRes = git(["log", "--max-parents=0", "--format=%H", `${dc.target.remote}/${anchorBranch}`], { safe: true });
    if (!initRes.ok) {
      fail(`Failed to find init commit on ${dc.target.remote}/${anchorBranch}: ${initRes.stderr}`);
    }
    targetInit = initRes.stdout.split("\n")[0] || null;
  }

  const { haltedSources, haltRecords } = replayCommits({ newCommits, syncedShaMap, absorbedMap, targetInit, dc, graph });

  // Surface ORIGINAL halts (diagnostic present). Stranded propagated commits
  // whose root halt was squash-absorbed on another lineage get a promoted
  // diagnostic — one per root halt, not one per stranded commit.
  const haltedBranches: HaltedBranch[] = [];
  const surfacedRoots = new Set<string>();
  const surface = (sha: string, record: HaltRecord, diagnostic: string) =>
    haltedBranches.push({
      branch: inferSourceBranch(sha, dc.source.remote),
      commitSha: sha,
      commitShort: record.commitShort,
      mappedParents: record.anchorCommits,
      diagnostic,
    });
  for (const [sha, record] of haltRecords) {
    if (!record.diagnostic) continue;
    if (record.rootHalt) surfacedRoots.add(record.rootHalt);
    surface(sha, record, record.diagnostic);
  }
  for (const [sha, record] of haltRecords) {
    if (record.diagnostic || !record.rootHalt || surfacedRoots.has(record.rootHalt)) continue;
    const entries = absorbedMap.get(record.rootHalt);
    if (!entries || entries.length === 0) continue; // root still pending — it surfaces itself above
    surfacedRoots.add(record.rootHalt);
    surface(sha, record, formatAbsorbedElsewhereDiagnostic({
      commitSha: sha, commitShort: record.commitShort,
      absorbedAncestor: record.rootHalt, entries, dc,
    }));
  }

  console.log();
  const replayedCount = newCommits.length - haltedSources.size;
  if (haltedBranches.length > 0) {
    console.log(`Done. ${replayedCount} commit(s) replayed; ${haltedBranches.length} halt(s) (${haltedSources.size} commit(s) blocked).`);
  } else {
    console.log(`Done. ${newCommits.length} commit(s) replayed.`);
  }

  return {
    mirrored: replayedCount,
    branchMapping: mapBranchesToTargetTips(graph, dc.source.remote, branches, syncedShaMap, absorbedMap),
    syncedShaMap: flattenMappings(syncedShaMap, absorbedMap),
    upToDate: false,
    haltedBranches,
  };
}

// ── Tag sync ──────────────────────────────────────────────────────────────────

/**
 * Source repo's tags are recreated on target, repointed at the replayed
 * commit. Annotated tags get a fresh tag object (same name, tagger, message;
 * new `object` line). Lightweight tags become `refs/tags/<name>` pointing
 * directly at the replay. Tags whose source commit was dropped (no entry in
 * syncedShaMap) are skipped — there's no target SHA to point at.
 */
export function syncTags(opts: {
  source: RepoEndpoint;
  target: RepoEndpoint;
  syncedShaMap: Map<string, string>;
}): { pushed: number; skipped: number; upToDate: number; failed: number } {
  const { source, target, syncedShaMap } = opts;

  // --force: plain --tags refuses to move an existing local tag, so a source
  // re-tag would otherwise never propagate (and with multiple pairs fetching
  // into the shared refs/tags namespace, first-fetched would win forever).
  git(["fetch", source.remote, "--tags", "--force"], { safe: true });

  // %(*objectname) peels annotated tags to their commit (empty for lightweight)
  // — avoids a rev-parse spawn per tag.
  const listRes = git(
    ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)|%(*objectname)"],
    { safe: true },
  );
  if (!listRes.ok || !listRes.stdout) return { pushed: 0, skipped: 0, upToDate: 0, failed: 0 };
  const tagLines = listRes.stdout.split("\n").filter(Boolean);
  if (tagLines.length === 0) return { pushed: 0, skipped: 0, upToDate: 0, failed: 0 };

  console.log(`\n── Syncing tags (${tagLines.length} candidate(s)) ──`);

  // Skip already-correct tags. Must be ls-remote: local refs/tags/* hold the
  // SOURCE tags fetched above, not the target's state.
  const remoteTags = new Map<string, string>();
  const lr = git(["ls-remote", "--tags", target.remote], { safe: true });
  if (lr.ok) {
    for (const l of lr.stdout.split("\n")) {
      const [sha, ref] = l.split("\t");
      if (ref && ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) {
        remoteTags.set(ref.slice("refs/tags/".length), sha);
      }
    }
  }

  let pushed = 0;
  let skipped = 0;
  let upToDate = 0;
  let failed = 0;
  for (const line of tagLines) {
    // name|objecttype|objectname|peeled-commit (blank if lightweight)
    const sep1 = line.indexOf("|");
    const sep2 = line.indexOf("|", sep1 + 1);
    const sep3 = line.indexOf("|", sep2 + 1);
    const name = line.slice(0, sep1);
    const objectType = line.slice(sep1 + 1, sep2);
    const objectName = line.slice(sep2 + 1, sep3);
    const peeledCommit = line.slice(sep3 + 1);
    const sourceCommit = peeledCommit || objectName;  // commit for both kinds; no spawn
    if (!sourceCommit) { skipped++; continue; }

    const targetCommit = syncedShaMap.get(sourceCommit);
    if (!targetCommit) {
      // Expected (tag on an unreplayed commit); don't log — can be thousands.
      skipped++;
      continue;
    }

    let pushSHA: string;
    if (objectType === "tag") {
      // Annotated: rebuild tag object with new commit-target.
      const tagBodyRes = git(["cat-file", "tag", `refs/tags/${name}`], { safe: true });
      if (!tagBodyRes.ok || !tagBodyRes.stdout) { skipped++; continue; }
      const newBody = tagBodyRes.stdout.replace(/^object [0-9a-f]+/m, `object ${targetCommit}`);
      const mktagRes = git(["mktag"], { input: newBody, safe: true });
      if (!mktagRes.ok || !mktagRes.stdout) {
        console.log(`  ✘ ${name}: mktag failed (${mktagRes.stderr.slice(0, 120)})`);
        failed++;
        continue;
      }
      pushSHA = mktagRes.stdout;
    } else {
      pushSHA = targetCommit;
    }

    // pushSHA fingerprints the whole tag, so a re-annotation (same commit,
    // new message/tagger) still differs and falls through to the push.
    if (remoteTags.get(name) === pushSHA) {
      upToDate++;
      continue;
    }

    // Force-push: source is the source of truth for tags, so target may need
    // to overwrite a previous propagation if the source moved the tag.
    const pushRes = git(
      ["push", target.remote, `+${pushSHA}:refs/tags/${name}`],
      { safe: true },
    );
    if (!pushRes.ok) {
      console.log(`  ✘ ${name}: push failed (${pushRes.stderr.trim().slice(0, 120)})`);
      failed++;
      continue;
    }
    console.log(`  ${name}${objectType === "tag" ? " (annotated)" : ""}: ${sourceCommit.slice(0, 8)} → ${targetCommit.slice(0, 8)} ✓`);
    pushed++;
  }

  console.log(`Tags: ${pushed} pushed, ${upToDate} up to date, ${skipped} skipped (source commit not replayed), ${failed} failed.`);
  return { pushed, skipped, upToDate, failed };
}
