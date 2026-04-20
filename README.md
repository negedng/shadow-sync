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

The tool needs a git repo as its workspace (for the git object database). Two modes:

**From inside one of the repos (workspace mode)** — install shadow-sync and run it directly. That repo is `origin`, the other is added as a remote.

```bash
npm install negedng/shadow-sync
```

**Standalone orchestrator** — the tool runs from its own repo, independent of both synced repos. Both are added as remotes. Set `SHADOW_CONFIG` to point at your config.

```bash
npm install negedng/shadow-sync
cross-env SHADOW_CONFIG=./shadow-config.json npx tsx node_modules/shadow-sync/shadow-sync.ts
```

Both modes use the same code and config. The only difference is whether one endpoint uses `"remote": "origin"` (no url needed) or both have explicit urls.

## Configuration

Create a `shadow-config.json` (copy from `shadow-config.example.json`).

**Workspace mode** — running from inside one of the repos:

```json
{
  "pairs": [
    {
      "name": "backend",
      "a": { "remote": "origin", "dir": "backend" },
      "b": { "remote": "backend-repo", "url": "https://github.com/org/backend.git", "dir": "" }
    }
  ]
}
```

**Orchestrator mode** — running from a standalone repo:

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
- `url` tells the tool how to reach the repo (omit if the remote already exists, e.g. `origin`)

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

- **`EXTERNAL_REPO_TOKEN`** — fine-grained PAT with Contents: Read and Write on every external repo shadow-sync will push to.
  - **Workspace mode** (tool runs inside one of the synced repos): required for push (pushes to the external B-side repos); optional for pull (pull pushes back to `origin`, which `GITHUB_TOKEN` covers — the pull workflow falls back to `github.token` automatically when the secret is absent).
  - **Orchestrator mode** (tool runs from a standalone repo): required for both push and pull — neither endpoint is the caller's origin, so every push is cross-repo. The PAT must cover all three external repos listed in `shadow-config.json` (both A-side and B-side).

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-r` / `--pair` | Pair name | All pairs |
| `--from` | Direction: `a` or `b` | `b` |
| `-b` | Branch to sync | All branches (remote) or current branch (workspace) |

## Setup

1. Install shadow-sync and add scripts to your `package.json`:

```bash
npm install negedng/shadow-sync cross-env tsx
```

```json
{
  "scripts": {
    "setup": "cross-env SHADOW_CONFIG=./shadow-config.json tsx node_modules/shadow-sync/shadow-setup.ts",
    "sync": "cross-env SHADOW_CONFIG=./shadow-config.json tsx node_modules/shadow-sync/shadow-sync.ts"
  }
}
```

2. Create `shadow-config.json` from the example:

```bash
cp node_modules/shadow-sync/shadow-config.example.json shadow-config.json
# Edit shadow-config.json with your pair definitions
```

3. Record a seed baseline (tells sync where history starts). The seed commit is built via plumbing and pushed directly to the target remote — it never modifies your workspace HEAD, so this works the same in workspace and orchestrator modes:

```bash
npm run setup -- -r backend
```

Default `--from b` records RepoB's current tip as the baseline; the seed commit lands on RepoA's main. By default, setup seeds every branch present on both remotes (idempotent — re-running skips already-seeded branches). Pass `-b <branch>` to seed just one branch.

4. Create the external repo with the same content as your subdirectory. The external repo must start with the same files so both sides agree on the baseline:

```bash
mkdir backend-repo && cd backend-repo && git init
cp -r ../your-monorepo/backend/* .
git add -A && git commit -m "Initial backend (from monorepo)"
git remote add origin https://github.com/org/backend.git
git push -u origin main
```

5. Sync and merge:

```bash
npm run sync -- -r backend --from a    # push monorepo changes to external
npm run sync -- -r backend --from b    # pull external changes to monorepo
git merge origin/shadow/backend/main   # merge the shadow branch
```

## Tests

```bash
npm test
```

Automated tests covering pull, push, merge, branching, binary files, LFS, symlinks, submodules, multi-seed, and more.

## Files

| File | Purpose |
|------|---------|
| `shadow-config.example.json` | Example pair definitions, trailers, git config overrides |
| `shadow-common.ts` | Config, git helpers, unified replay engine |
| `shadow-setup.ts` | Bootstrap: builds a seed commit via plumbing and pushes it to the target remote; additive across branches |
| `shadow-sync.ts` | Single script for both directions (--from a or --from b) |
| `.shadowignore` | Ignore patterns (auto-discovered from source commit, like `.gitignore`) |
| `shadow-sync-explained.html` | Detailed technical documentation |
| `shadow-tests/` | 17 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron) |
| `.github/workflows/shadow-forward.yml` | CI push workflow (on shadow branch push) |
