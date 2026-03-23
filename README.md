# Shadow Sync

Mirror files between a mono-repo and external team repositories using git. Each external repo maps to a local subdirectory (e.g. `backend/`, `frontend/`). Commits are replayed individually to preserve authorship, timestamps, and history.

## How it works

```
┌──────────────────┐     shadow-pull      ┌──────────────────┐
│  Team repos      │  ─────────────────>  │  Mono-repo       │
│  (git remotes)   │                      │  backend/        │
│  backend         │  <─────────────────  │  frontend/       │
│  frontend        │     shadow-push      │                  │
└──────────────────┘                      └──────────────────┘
```

## shadow-pull

Fetches from a remote and replays each new commit as a patch into the matching subdirectory.

```bash
npx tsx shadow-pull.ts -r frontend
npx tsx shadow-pull.ts -r backend -b feature/auth
```

- Preserves original author, committer, and timestamps
- Tracks mirrored commits via `Shadow-synced-from: <hash>` trailers to prevent duplicates
- Falls back to 3-way merge when patches don't apply cleanly
- On merge conflicts: leaves standard git conflict markers (`<<<<<<<`/`>>>>>>>`), saves state, and exits. After resolving and staging, re-running the command resumes where it left off
- Skips commits that originated from `shadow-push` (detected via trailer) to prevent round-trip duplication
- Automatically detects feature branches and only mirrors branch-specific commits (uses `main..feature` range)
- Warns when the remote branch name differs from your local branch

## shadow-push

Snapshots the current subdirectory, diffs it against the remote branch, and pushes the result as a single commit.

```bash
npx tsx shadow-push.ts -r frontend -m "Add login page"
npx tsx shadow-push.ts -r frontend -b feature/new-page -m "Add new page"
```

- Multiple local commits and branch merges are squashed into one remote commit
- Marks commits with `Shadow-pushed-from: <hash>` trailer so `shadow-pull` can skip them
- Respects `.shadowignore` patterns (glob, one per line) to exclude files from being pushed
- Auto-creates new remote branches when `-b` is explicitly passed
- Refuses to push if the subdirectory has uncommitted changes

## Options

**shadow-pull:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in `REMOTES` |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch on the remote | Current local branch |
| `-s` | Only sync commits after this date | `SYNC_SINCE` in config |
| `-n` | Dry run — show what would be synced | |
| `--seed` | Record remote HEAD as sync baseline | |

**shadow-push:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in `REMOTES` |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch on the remote | Current local branch |
| `-m` | Commit message (required) | |
| `-n` | Dry run — show what would be pushed | |

## Setup

1. Add git remotes:

```bash
git remote add backend   git@their-server.com:backend.git
git remote add frontend  git@their-server.com:frontend.git
```

2. Edit the `REMOTES` array in `shadow-common.ts`:

```typescript
export const REMOTES: RemoteConfig[] = [
  { remote: "backend",  dir: "backend"  },
  { remote: "frontend", dir: "frontend" },
];
```

3. Set `SYNC_SINCE` to the date you started syncing (commits before this are ignored):

```typescript
export const SYNC_SINCE: string | undefined = "2024-11-01";
```

## Initial bootstrap

When setting up the monorepo for the first time, copy the current state of each remote's main branch into the matching subdirectory, then use `--seed` to mark the sync baseline:

```bash
# 1. Copy files from each team repo into your monorepo subdirectories
cp -r /path/to/backend-repo/* backend/
cp -r /path/to/frontend-repo/* frontend/
git add -A && git commit -m "Bootstrap monorepo from team repos"

# 2. Seed each remote so future pulls skip the existing history
npx tsx shadow-pull.ts -r backend --seed
npx tsx shadow-pull.ts -r frontend --seed

# 3. From now on, regular pull/push works
npx tsx shadow-pull.ts -r backend
npx tsx shadow-push.ts -r frontend -m "My changes"
```

Without `--seed`, the first pull would attempt to replay every remote commit (after `SYNC_SINCE`) on top of files you already copied, causing conflicts.

## Pulling feature branches

To pull a feature branch from a remote, create a matching local branch first:

```bash
git checkout -b feature/auth
npx tsx shadow-pull.ts -r backend -b feature/auth
```

Shadow-pull automatically detects that `feature/auth` is not the default branch and uses range syntax (`main..feature/auth`) to only mirror the branch-specific commits — not the entire main history.

If you forget to switch branches, shadow-pull will warn you:

```
⚠ Pulling remote branch 'feature/auth' while on local branch 'main'.
  Consider: git checkout -b feature/auth
```

## Tests

Run all tests (creates isolated temporary repos, nothing touches real remotes):

```bash
npx tsx shadow-tests/run-all.ts
```

Run a single test:

```bash
npx tsx shadow-tests/test-pull-conflict.ts
```

## Files

| File | Purpose |
|------|---------|
| `shadow-common.ts` | Shared config, git helpers, patch application, conflict state |
| `shadow-pull.ts` | Mirrors remote commits into a local subdirectory |
| `shadow-push.ts` | Pushes local subdirectory state to a remote as a single commit |
| `.shadowignore` | Glob patterns for files to exclude from push (optional) |
| `shadow-tests/` | Automated test suite (`npx tsx shadow-tests/run-all.ts`) |
