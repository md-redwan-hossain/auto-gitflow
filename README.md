# gitea-automation

CLI that runs a list of Gitea steps from a config file: list PRs, open/merge a PR, wait for Actions, dispatch workflows.

**Stack:** [Bun](https://bun.sh) + TypeScript. Talks to your Gitea API with a personal token.

---

## Start here (about 5 minutes)

1. Install Bun if you do not have it: https://bun.sh
2. In this folder, run:

```bash
bun install
cp .env.example .env
cp config.jsonc.example config.jsonc
```

3. Put your Gitea token in `.env`:

```env
GITEA_TOKEN=your_token_here
```

Token needs **repository → Read and Write** (`write:repository`).

4. Edit `config.jsonc` (repos, branches, workflows for your setup).

5. Check the config:

```bash
bun run doctor
```

6. Run:

```bash
bun start
```

Or pick a repo by label:

```bash
bun start -- -r retailr-server
```

---

## Commands

| Command | What it does |
|---------|----------------|
| `bun start` | Run the step pipeline (prompts for repo if more than one) |
| `bun start -- -r <label>` | Skip the repo picker |
| `bun start -- -c path/to/config.jsonc` | Use another config file |
| `bun run doctor` | Parse + validate config (no API token needed) |
| `bun run typecheck` | TypeScript check |

---

## Config (`config.jsonc`)

- **Gitignored.** Copy from `config.jsonc.example`. Do not commit secrets or personal branch names if you prefer not to.
- Missing or empty file → tool warns and exits. Fix by copying the example again.
- Steps run **in array order** for the selected repo.

### Step types

#### `list-pr`

Shows PRs (optional author filter).

```jsonc
{
  "type": "list-pr",
  "status": "open",   // open | closed | all
  "user": "redwan"    // optional: author login
}
```

#### `create-pr`

Creates a PR, merges (now or when checks pass), then optionally waits for Actions workflows.

```jsonc
{
  "type": "create-pr",
  "sourceBranch": "redwan",
  "destinationBranch": "develop",
  "mergeWhenChecksSucceed": "ask",  // ask | yes | no
  "waitFor": ["develop-branch-docker.yaml"],
  "eager": false,
  "needConfirmation": false
}
```

| Situation | Behavior |
|-----------|----------|
| Open PR already exists (same branches) | Warn and **exit** — does not touch that PR |
| Create returns duplicate / 409 | Same — **exit** |
| No commits ahead (empty diff) | Skip this step, **continue** the pipeline |

`waitFor`: after the PR merges, poll each workflow until success (timeout ~45 minutes).

#### `run-workflow`

Dispatches a `workflow_dispatch` workflow on a ref.

```jsonc
{
  "type": "run-workflow",
  "workflow": "staging-deploy.yaml",
  "ref": "develop",
  "eager": true,
  "needConfirmation": true
}
```

If the workflow YAML has inputs, you are prompted (YAML defaults + history). If it has no inputs, it dispatches with `{}`.

---

## `eager` and `needConfirmation`

| Flag | Meaning |
|------|---------|
| `eager: true` on **run-workflow** | Collect dispatch inputs **before** the step loop. Saved to `history.jsonc` **immediately** when you answer. |
| `eager: true` on **create-pr** | Ask the run/skip confirm **up front** (with other eager prompts). |
| `needConfirmation: true` | Ask “Run this step?” before doing it. Decline → skip that step, continue the rest. |

Timing:

- `needConfirmation` + `eager` → confirm once at the start
- `needConfirmation` only → confirm when that step’s turn arrives
- Confirm answers are **never** stored in history (only workflow input values are)

---

## History (`history.jsonc`)

- Gitignored. Stores last-used `workflow_dispatch` inputs per repo + workflow name.
- On the next run you can reuse them.
- Written when you finish answering eager prompts, and again after a successful dispatch.

---

## Example flow (retailr-server)

Typical order in the example config:

1. List open PRs  
2. PR `redwan` → `develop`, wait for docker build  
3. Confirm + dispatch staging deploy (inputs collected early)  
4. Confirm + PR `develop` → `main`, wait for main docker  
5. Dispatch production deploy (inputs already collected + in history)

---

## Files you care about

| File | Role |
|------|------|
| `config.jsonc` | Your steps (local, gitignored) |
| `config.jsonc.example` | Template to copy |
| `.env` | `GITEA_TOKEN` (gitignored) |
| `history.jsonc` | Past workflow inputs (gitignored) |
| `src/` | CLI source |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Config not found / empty | `cp config.jsonc.example config.jsonc` then edit |
| `doctor` fails | Fix the reported Zod / parse errors |
| Token / 403 | Create a token with `write:repository` |
| Stuck on “waiting for workflow” | Check the workflow file name matches Gitea Actions; open the run URL in Gitea |
| Open PR exists → tool exits | Expected. Close/merge that PR or change branches in config |

Next: run `bun run doctor`, then `bun start`.
