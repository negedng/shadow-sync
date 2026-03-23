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

Both scripts accept:

| Flag | Description | Default |
|------|-------------|---------|
| `-r` | Remote name | First entry in `REMOTES` |
| `-d` | Local subdirectory | Inferred from remote config |
| `-b` | Branch on the remote | Current local branch |

`shadow-push` additionally requires `-m "commit message"`.

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
