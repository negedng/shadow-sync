# Shadow Sync

Bi-directional git sync between two repositories with path prefix remapping. Commits are replayed individually to preserve authorship, timestamps, and history. Merge topology (branches, merge commits, shared ancestors) is preserved.

For a detailed technical deep dive, see [`shadow-sync-explained.html`](shadow-sync-explained.html).

## How it works

Given two repos — **RepoA** (has a `backend/` folder) and **RepoB** (backend at root):

```
RepoA                                    RepoB
backend/src/app.ts  ←──── sync ────→  src/app.ts
backend/README.md   ←──── sync ────→  README.md
other-stuff/...     (not synced)
```

Shadow sync replays commits between them, adding or stripping the `backend/` prefix as needed. Each endpoint has a **label**; commits replayed *from* an endpoint land on a shadow branch named after that label, which the other team merges.

```
shadow-sync --from b:  RepoB(bb) → bb/main on RepoA → git merge → RepoA's main
shadow-sync --from a:  RepoA(mb) → mb/main on RepoB → git merge → RepoB's main
```

### Where does the tool run?

The tool runs from a standalone orchestrator repo, independent of both synced repos. Both are added as remotes. Set `SHADOW_CONFIG` to point at your config.

```bash
npm install negedng/shadow-sync
cross-env SHADOW_CONFIG=./shadow-config.json npx tsx node_modules/shadow-sync/shadow-sync.ts
```

## Configuration

Create a `shadow-config.json` (copy from `shadow-config.example.json`):

```json
{
  "pairs": [
    {
      "name": "backend",
      "a": { "remote": "main-repo",    "url": "https://github.com/org/monorepo.git", "label": "mb" },
      "b": { "remote": "backend-repo", "url": "https://github.com/org/backend.git",   "label": "bb" },
      "mappings": [
        { "a": "backend", "b": "" }
      ]
    }
  ]
}
```

- `a` and `b` are symmetric — direction is chosen at runtime with `--from`
- each endpoint sets a `label` (e.g. `"mb"`, `"bb"`) — it names that endpoint's shadow refs (`<label>/<branch>`) and replay-trailer keys (`<sourceLabel>-to-<targetLabel>`). Labels must be unique across all pairs and match `[A-Za-z0-9][A-Za-z0-9-]*`
- `mappings` lists the folder pairs to sync. Each mapping's `a` and `b` are path prefixes on the respective sides (`""` for repo root, `"backend"` for a subdirectory)
- One pair can carry multiple mappings — e.g. a `backend` mapping for the primary slice plus a `common` mapping for a shared folder that lives at different paths on each side
- `url` tells the tool how to reach the repo
- An endpoint may set `"anchorBranch"` (default `"main"`) — the branch whose init commit anchors replayed orphan history on that side. Set it if the repo's mainline is `master`/`trunk`

Optional top-level fields (see `shadow-config.example.json`): `gitConfigOverrides` (`-c` flags applied to every git call), `maxBuffer`, `identities`, `sides`.

A top-level `"sides"` object gives the two endpoints friendly names for the `--from` flag — e.g. `"sides": { "a": "mono", "b": "ext" }` lets `--from mono` / `--from ext` stand in for `--from a` / `--from b` (the literal `a`/`b` keep working). The two names must be distinct and not be the literal `"a"`/`"b"`. The codebase still refers to the sides as `a`/`b` internally.

A top-level `"identities"` list maps one person's git identity across remotes. Each entry binds a remote name to that person's `{ name, email }` on it; replaying a commit from remote S to remote T rewrites the author/committer whose email matches the S binding (case-insensitive) to the T binding. Dates, messages, and anyone without a matching entry pass through verbatim. Emails must be unique per remote across entries — the mapping runs in both directions, so a duplicate would make the reverse lookup ambiguous. Only commits replayed after the config lands are affected; existing shadow commits keep their recorded identity.

```json
"identities": [
  {
    "main-repo":     { "name": "X Mono",     "email": "x@corp.example.com" },
    "backend-repo":  { "name": "X External", "email": "x@gmail.example.com" }
  }
]
```

Labels are baked into shadow ref names and replay-trailer keys, which are the engine's only persistent state. Renaming a label on a live deployment makes the engine treat the deployment as un-synced and re-replay everything — change labels only as part of a full re-bootstrap, not on a running deployment.

### `branch-filters.json` (required)

Next to `shadow-config.json`, create `branch-filters.json` — an explicit allowlist of which branches sync from each remote (copy from `branch-filters.example.json`):

```json
{
  "filters": {
    "backend-repo": ["main", "release/*"],
    "main-repo": ["main"]
  }
}
```

Patterns support `*` and `**` globs (`["**"]` allows everything). **The filter is fail-closed: a missing or empty file means zero branches sync.** This is deliberate — the allowlist is the operator's explicit declaration of what leaves a repo, and silently falling back to "sync everything" would defeat it.

## Usage

One script, one command — direction is a flag:

```bash
# Pull: replay b's commits into shadow branches on a
npm run sync -- --from b

# Push: replay a's commits into shadow branches on b
npm run sync -- --from a

# Target a specific pair
npm run sync -- --from b -r backend

# Target a specific branch
npm run sync -- --from a -r backend -b feature/auth
```

After syncing, merge the shadow branch (named after the label of the endpoint you synced *from* — `bb` in the example config):
```bash
git fetch origin
git merge origin/bb/main
```

### When merge replay halts

In rare cases the engine can't auto-resolve a source-side merge because the mapped target-side parents disagree on **outer state** — files outside the synced subdirectory, which the source commit's scope can't have authored. This happens when both sides committed to the same branch concurrently and merged each other's work back at different times (no-echo case), or when a source octopus directly merges multiple shadow refs whose target-side counterparts diverged on outer (multi-echo case). The engine halts the affected branch (other branches keep syncing) with a recipe and a non-zero exit, rather than guessing.

Two recovery flows:

**Round-trip + squash (preferred).** Resolve the merge on the target's working branch as you would normally. The next sync cycle naturally propagates the resolution back, and the engine absorbs the halted commits into a single squashed shadow commit — no flags, no shape detection.

```bash
# 1. The sync halted on Bm (a source-side merge whose outer can't be reconciled).
#    Switch to the target's working branch.
cd /path/to/monorepo
git checkout core-dev

# 2. Resolve the merge as you would normally. Suppose Bm merges project → core-dev:
git merge --no-ff project
# ... resolve conflicts, commit ...
git push origin core-dev    # creates Mm

# 3. Run sync the OTHER direction so Mm reaches the source repo's shadow ref:
npm run sync -- --from a    # Mm replayed onto mb/core-dev on the backend repo

# 4. On the source side, merge that shadow ref into the working branch:
cd /path/to/backend
git checkout core-dev
git merge origin/mb/core-dev    # produces R_be
git push origin core-dev

# 5. Re-run the original direction. The engine sees R_be, fast-forwards through
#    Mm via merge-tree, and absorbs Bm (and any descendants halted with it)
#    into the resulting shadow commit via multi-trailer encoding.
npm run sync -- --from b
```

The squash carries a single `<sourceLabel>-to-<targetLabel>` trailer whose value lists its own source SHA first, then one absorbed source SHA per folded commit. On subsequent runs `loadReplayedMappings` reads that trailer and skips the absorbed commits, so the squash is idempotent.

Absorbed mappings are **lineage-scoped**: the squash stands in for an absorbed commit only on branches that contain the resolving merge (`R_be`). A branch that forked off the halted commit *before* the resolution landed does not inherit the squash — its shadow ref stays at the last faithful commit and the engine halts it with its own recipe: merge the resolved branch's **shadow ref** into the fork (the ref carries the resolution echo, which preserves the fork's own content during the absorbing replay), push, and re-run.

**Hand-built resolution on the shadow ref (always available).** When you'd rather build the resolution directly without touching the target's working branch, follow the recipe the engine printed: create a commit on the shadow ref whose tree is your manual resolution, parents are the divergent mapped parents, and message carries `<sourceLabel>-to-<targetLabel>: <Bm-sha>`. Push that to the shadow ref and re-run sync. `loadReplayedMappings` picks up the trailer and skips Bm on the next run.

Both flows are exercised end-to-end by `shadow-tests/test-halt-recovery-variants.ts`.

### `.shadowignore`

Works like `.gitignore` — commit a `.shadowignore` file in your repo and it's automatically discovered during replay. Each side controls what it sends to the other.

Place `.shadowignore` at the root of the synced content:
- In RepoA (dir = `backend`): `backend/.shadowignore`
- In RepoB (dir = ``): `.shadowignore`

Example `.shadowignore`:
```
CLAUDE.md
.cursor/
**/*.local
```

**Nested mappings within a pair are auto-excluded.** When one pair carries multiple `mappings` and one mapping's path nests under another's on the same side, the engine auto-derives ignore patterns at replay time so the outer mapping never carries the inner mapping's content. Example: a `backend` pair with `{ a: "backend", b: "" }` (primary) plus `{ a: "common", b: "src/common" }` (nested common slice) — the engine skips `src/common/**` when replaying through the primary mapping without any `.shadowignore` file, so the common content lands on mono's `common/` via the longer-prefix mapping only. Manual `.shadowignore` files still work and are unioned with auto-derived patterns.

## GitHub Actions

Both workflows in `.github/workflows/` are **reusable** (`workflow_call:`) so consumers don't duplicate them — they add a thin caller workflow and the logic stays here.

### Consumer setup (one-time)

Create these two files in the consumer repo:

**`.github/workflows/shadow-sync.yml`** — pull from B:

```yaml
name: Shadow Sync (Pull from B)
on:
  workflow_dispatch:
  # schedule: [{ cron: '*/15 * * * *' }]   # enable when ready
permissions:
  contents: write
jobs:
  sync:
    uses: negedng/shadow-sync/.github/workflows/shadow-sync.yml@main
    secrets: inherit
```

**`.github/workflows/shadow-forward.yml`** — push from A:

```yaml
name: Shadow Sync (Push from A)
on:
  workflow_dispatch:
  # schedule: [{ cron: '*/15 * * * *' }]   # enable when ready
permissions:
  contents: read
jobs:
  sync:
    uses: negedng/shadow-sync/.github/workflows/shadow-forward.yml@main
    secrets: inherit
```

Both reusable workflows invoke `npm run sync -- --from b/a`, so the consumer's `package.json` must have a `sync` script that calls `shadow-sync.ts` with the correct `SHADOW_CONFIG` env var pointing at the local `shadow-config.json`. See the [Setup](#setup) section below.

**Why the explicit `permissions:` block** — a reusable workflow's declared permissions can't exceed the caller's, and the default `default_workflow_permissions` in most repos is `read`. The pull callee needs `contents: write` (pushes shadow branches), so the caller must grant at least that. Forward's callee is `contents: read` (it pushes via PAT, not `GITHUB_TOKEN`).

### Secrets

- **`EXTERNAL_REPO_TOKEN`** — fine-grained PAT with Contents: Read and Write on every external repo listed in `shadow-config.json`. The orchestrator has no synced content of its own, so every push is cross-repo and the PAT must cover every A-side and B-side repo the config references.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p` / `--pair` | Pair name (`-r` / `--remote` is an alias) | All pairs |
| `-f` / `--from` | Direction: `a` or `b` | `b` |
| `-b` / `--branch` | Branch to sync (bypasses `branch-filters.json`) | All allowed branches |
| `-n` / `--dry-run` | Replay but push nothing | off |
| `--tags` | Also run the tag sync phase | off |
| `-h` / `--help` | Show usage | |

## Setup

1. Install shadow-sync and add a script to your `package.json`:

```bash
npm install negedng/shadow-sync cross-env tsx
```

```json
{
  "scripts": {
    "sync": "cross-env SHADOW_CONFIG=./shadow-config.json tsx node_modules/shadow-sync/shadow-sync.ts"
  }
}
```

2. Create `shadow-config.json` and `branch-filters.json` from the examples:

```bash
cp node_modules/shadow-sync/shadow-config.example.json shadow-config.json
cp node_modules/shadow-sync/branch-filters.example.json branch-filters.json
# Edit shadow-config.json with your pair definitions and
# branch-filters.json with the branch allowlist per remote
```

3. Sync and merge. The first run replays each side's full history into the other's shadow branches (named `<sourceLabel>/<branch>`), anchored at the target's init commit (or the closest round-tripped echo when one exists) — so plain `git merge origin/<sourceLabel>/<branch>` always finds a real merge base. The `<sourceLabel>-to-<targetLabel>` trailer makes replay idempotent: re-running is a no-op once both sides are in sync.

```bash
npm run sync -- -r backend --from a    # push monorepo changes to external
npm run sync -- -r backend --from b    # pull external changes to monorepo
git merge origin/bb/main               # merge the shadow branch (bb = label synced from)
```

The first sync is proportional to source-side history (per-commit replay). For a fresh monorepo joining mature source repos, run it locally once and push the resulting shadow branches; subsequent CI syncs only handle the delta.

## Tests

```bash
npm test
```

Automated tests covering pull, push, merge, branching, binary files, LFS, symlinks, submodules, orphan-branch merges, and more.

## Files

| File | Purpose |
|------|---------|
| `shadow-config.example.json` | Example pair definitions, endpoint labels, git config overrides |
| `branch-filters.example.json` | Example per-remote branch allowlist (required, fail-closed) |
| `shadow-common.ts` | Config, git helpers, unified replay engine |
| `shadow-sync.ts` | Single script for both directions (--from a or --from b) |
| `.shadowignore` | Ignore patterns (auto-discovered from source commit, like `.gitignore`) |
| `shadow-sync-explained.html` | Detailed technical documentation |
| `shadow-tests/` | Automated test suite (`npm test`) |
| `.github/workflows/shadow-sync.yml` | Reusable pull workflow (`workflow_call` / `workflow_dispatch`) |
| `.github/workflows/shadow-forward.yml` | Reusable push workflow (`workflow_call` / `workflow_dispatch`) |
| `.github/workflows/test.yml` | CI: runs the test suite on push/PR |
