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

Shadow sync replays commits between them, adding or stripping the `backend/` prefix as needed. Each side gets a `shadow/` branch that the other team merges.

```
shadow-sync --from b:  RepoB → shadow/backend/main on RepoA → git merge → RepoA's main
shadow-sync --from a:  RepoA → shadow/backend/main on RepoB → git merge → RepoB's main
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
      "a": { "remote": "main-repo", "url": "https://github.com/org/monorepo.git", "dir": "backend" },
      "b": { "remote": "backend-repo", "url": "https://github.com/org/backend.git", "dir": "" }
    }
  ]
}
```

- `a` and `b` are symmetric — direction is chosen at runtime with `--from`
- `dir` is the path prefix in that repo (`""` for root, `"backend"` for a subdirectory)
- `url` tells the tool how to reach the repo

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

After syncing, merge the shadow branch:
```bash
git fetch origin
git merge origin/shadow/backend/main
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
npm run sync -- --from a    # Mm replayed onto shadow/<pair>/core-dev on source repo

# 4. On the source side, merge that shadow ref into the working branch:
cd /path/to/backend
git checkout core-dev
git merge origin/shadow/backend/core-dev    # produces R_be
git push origin core-dev

# 5. Re-run the original direction. The engine sees R_be, fast-forwards through
#    Mm via merge-tree, and absorbs Bm (and any descendants halted with it)
#    into the resulting shadow commit via multi-trailer encoding.
npm run sync -- --from b
```

The engine adds one `Shadow-replayed-<pair>-<source-remote>` trailer per absorbed source SHA on the new shadow commit. On subsequent runs `loadReplayedMappings` reads those trailers and skips the absorbed commits, so the squash is idempotent.

**Hand-built resolution on the shadow ref (always available).** When you'd rather build the resolution directly without touching the target's working branch, follow the recipe the engine printed: create a commit on the shadow ref whose tree is your manual resolution, parents are the divergent mapped parents, and message carries `Shadow-replayed-<pair>-<source-remote>: <Bm-sha>`. Push that to the shadow ref and re-run sync. `loadReplayedMappings` picks up the trailer and skips Bm on the next run.

A worked example of both flows is in [`local_tests/conflict_squash/run_scenario.ts`](local_tests/conflict_squash/run_scenario.ts).

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

**Nested pairs are auto-excluded.** When two pairs in `shadow-config.json` share a remote and one pair's `dir` is nested inside the other's, the engine auto-derives ignore patterns at replay time so the outer pair never carries the inner pair's content. Example: a `backend` pair (`backend-repo` dir=``) and a `common-backend` pair (`backend-repo` dir=`src/common`) both target the same backend repo; the engine skips `src/common/**` when replaying the `backend` pair without any `.shadowignore` file. Manual `.shadowignore` files still work and are unioned with auto-derived patterns.

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
| `-r` / `--pair` | Pair name | All pairs |
| `--from` | Direction: `a` or `b` | `b` |
| `-b` | Branch to sync | All branches |

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

2. Create `shadow-config.json` from the example:

```bash
cp node_modules/shadow-sync/shadow-config.example.json shadow-config.json
# Edit shadow-config.json with your pair definitions
```

3. Sync and merge. The first run replays each side's full history into the other's `shadow/` branches, anchored at the target's init commit (or the closest round-tripped echo when one exists) — so plain `git merge origin/shadow/<pair>/<branch>` always finds a real merge base. The `Shadow-replayed-<remote>` trailer makes replay idempotent: re-running is a no-op once both sides are in sync.

```bash
npm run sync -- -r backend --from a    # push monorepo changes to external
npm run sync -- -r backend --from b    # pull external changes to monorepo
git merge origin/shadow/backend/main   # merge the shadow branch
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
| `shadow-config.example.json` | Example pair definitions, trailers, git config overrides |
| `shadow-common.ts` | Config, git helpers, unified replay engine |
| `shadow-sync.ts` | Single script for both directions (--from a or --from b) |
| `.shadowignore` | Ignore patterns (auto-discovered from source commit, like `.gitignore`) |
| `shadow-sync-explained.html` | Detailed technical documentation |
| `shadow-tests/` | 16 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron) |
| `.github/workflows/shadow-forward.yml` | CI push workflow (on shadow branch push) |
