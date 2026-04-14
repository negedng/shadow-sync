# Shadow Sync

Bi-directional git sync between two repositories with path prefix remapping. Commits are replayed individually to preserve authorship, timestamps, and history. Merge topology (branches, merge commits, shared ancestors) is preserved.

For a detailed technical deep dive, see [`shadow/shadow-sync-explained.html`](shadow/shadow-sync-explained.html).

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

**From inside one of the repos** — simplest setup. The tool lives in the repo (e.g. RepoA's `shadow/` folder). That repo is `origin`, the other is added as a remote.

```
RepoA (your workspace)              RepoB (remote)
├── backend/                         ├── src/app.ts
│   └── src/app.ts                   └── README.md
├── frontend/
└── shadow/            ← tool lives here
    ├── shadow-sync.ts
    └── shadow-config.json
```

**Standalone orchestrator** — the tool runs from its own repo, independent of both synced repos. Both are added as remotes.

```
Orchestrator (standalone)            RepoA (remote)         RepoB (remote)
├── shadow-sync.ts                   ├── backend/           ├── src/app.ts
├── shadow-common.ts                 │   └── src/app.ts     └── README.md
├── shadow-config.json               └── frontend/
└── package.json
```

Both modes use the same code and config. The only difference is whether one endpoint uses `"remote": "origin"` (no url needed) or both have explicit urls.

## Configuration

Each **pair** connects two repos (**a** and **b**) with a path mapping:

```json
{
  "pairs": [
    {
      "name": "backend",
      "a": { "remote": "repo-a", "url": "https://github.com/org/repo-a.git", "dir": "backend" },
      "b": { "remote": "repo-b", "url": "https://github.com/org/repo-b.git", "dir": "" }
    }
  ]
}
```

- `a` and `b` are symmetric — direction is chosen at runtime with `--from`
- `dir` is the path prefix in that repo (`""` for root, `"backend"` for a subdirectory)
- `url` tells the tool how to reach the repo (omit if the remote already exists, e.g. `origin`)
- `ignore` (optional) — path to a `.shadowignore` file that filters what this side sends

The tool runs from any git repo. Both sides are equal peers.

## Usage

One script, one command — direction is a flag:

```bash
# Pull: replay b's commits into shadow branches on a
npm --prefix shadow run sync -- --from b

# Push: replay a's commits into shadow branches on b
npm --prefix shadow run sync -- --from a

# Target a specific pair
npm --prefix shadow run sync -- --from b -r backend

# Target a specific branch
npm --prefix shadow run sync -- --from a -r backend -b feature/auth
```

After syncing, merge the shadow branch:
```bash
git fetch origin
git merge origin/shadow/backend/main
```

### `.shadowignore`

Each endpoint can have its own ignore file — patterns for files to not send to the other side:

```json
{
  "a": { "remote": "repo-a", "url": "...", "dir": "backend", "ignore": "shadow/.shadowignore" },
  "b": { "remote": "repo-b", "url": "...", "dir": "" }
}
```

Example `.shadowignore`:
```
CLAUDE.md
.cursor/
**/*.local
```

## GitHub Actions

### Shadow Sync (Pull) — `.github/workflows/shadow-sync.yml`

Cron every 15 min. Runs `shadow-sync.ts --from b` for all pairs.

### Shadow Forward (Push) — `.github/workflows/shadow-forward.yml`

Triggers on push to `shadow/**` branches (only for commits with `Shadow-export:` trailer). Runs `shadow-sync.ts --from a`.

Requires `EXTERNAL_REPO_TOKEN` secret (fine-grained PAT with Contents: Read and write).

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-r` / `--pair` | Pair name | All pairs |
| `--from` | Direction: `a` or `b` | `b` |
| `-b` | Branch to sync | All branches (remote) or current branch (workspace) |

## Setup

1. Edit `shadow/shadow-config.json`:

```json
{
  "pairs": [
    {
      "name": "backend",
      "a": { "remote": "repo-a", "url": "https://github.com/org/repo-a.git", "dir": "backend" },
      "b": { "remote": "repo-b", "url": "https://github.com/org/repo-b.git", "dir": "" }
    }
  ]
}
```

2. Record a seed (tells sync where to start):

```bash
npm --prefix shadow run setup -- -r backend
```

3. Sync:

```bash
npm --prefix shadow run sync -- -r backend --from b
git merge origin/shadow/backend/main
```

## Tests

```bash
npm --prefix shadow test
```

## Files

| File | Purpose |
|------|---------|
| `shadow/shadow-config.json` | Pair definitions, trailers, git config overrides |
| `shadow/shadow-common.ts` | Config, git helpers, unified replay engine |
| `shadow/shadow-setup.ts` | Bootstrap: records seed so sync skips existing history |
| `shadow/shadow-sync.ts` | Single script for both directions (--from a or --from b) |
| `shadow/.shadowignore` | Default ignore patterns |
| `shadow/shadow-sync-explained.html` | Detailed technical documentation |
| `shadow/shadow-tests/` | 38 automated tests |
| `.github/workflows/shadow-sync.yml` | CI pull workflow (cron) |
| `.github/workflows/shadow-forward.yml` | CI push workflow (on shadow branch push) |
