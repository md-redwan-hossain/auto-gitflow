# gitrung

CLI that runs a list of steps from a config file: list PRs, open/merge a PR, wait for Actions, dispatch workflows.

Works with **Gitea** and **GitHub**. You choose per repo with `gitPlatform`.

**Stack:** [Bun](https://bun.sh) · TypeScript · [Zod](https://zod.dev) · Commander · `@clack/prompts` · ora · chalk

Binary name: `gitrung` (see `package.json` `bin`). Day to day you can still use `bun start`.

---

## Start here (about 5 minutes)

1. Install Bun if you do not have it: https://bun.sh
2. In this folder, run:

```bash
bun install
cp .env.example .env
cp config.jsonc.example config.jsonc
```

3. Put tokens in `.env`:

```env
GITEA_TOKEN=your_gitea_token
GITHUB_TOKEN=your_github_token
```

Only set the token(s) for platforms you use.

- **Gitea:** repository Read and Write (`write:repository`)
- **GitHub:** classic PAT with `repo` + `workflow` (or fine-grained: contents, pull requests, actions, and metadata)

4. Edit `config.jsonc`. Every repo needs `"gitPlatform": "gitea"` or `"github"`.

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

- **Gitignored.** Copy from `config.jsonc.example`.
- Missing or empty file → tool warns and exits.
- Steps run **in array order** for the selected repo.
- **Do not** infer platform from the URL — set `gitPlatform` yourself.
- JSONC: comments and trailing commas are fine (`Bun.JSONC.parse`).

### Repo shape

```jsonc
{
  "url": "https://git.example.com/org/repo",
  "label": "my-repo",
  "gitPlatform": "gitea",   // or "github"
  "steps": [ ... ]
}
```

| `gitPlatform` | Token | Workflow folder | API |
|---------------|--------|-----------------|-----|
| `gitea` | `GITEA_TOKEN` | `.gitea/workflows/` | `{host}/api/v1` |
| `github` | `GITHUB_TOKEN` | `.github/workflows/` | `api.github.com` (or `{host}/api/v3` for GH Enterprise) |

### Step types

#### `list-pr`

```jsonc
{
  "type": "list-pr",
  "status": "open",   // open | closed | all
  "user": "redwan"    // optional: author login
}
```

#### `create-pr`

```jsonc
{
  "type": "create-pr",
  // "sourceBranch": "redwan",   // optional — if omitted, prompt (+ history)
  "destinationBranch": "develop",
  "mergeWhenChecksSucceed": "ask",  // ask | yes | no
  "waitFor": ["develop-branch-docker.yaml"],
  "eager": false,
  "needConfirmation": false
}
```

**`sourceBranch`**

- Optional. If missing → prompt (reuse last value from `history.jsonc` if any) → save that one string per repo (overwrite, not a list).
- With `needConfirmation: true` → **Yes** / **Skip** / **Change source branch** (not a plain Yes/No). Change re-prompts, saves history, asks again.

**Runtime checks (before create)**

- Source and destination branches exist on the remote
- Each `waitFor` workflow file exists at `destinationBranch` under `.gitea/workflows/` or `.github/workflows/`

| Situation | Behavior |
|-----------|----------|
| Open PR already exists (same branches) | Warn and **exit** — does not touch that PR |
| Create returns duplicate / 409 | Same — **exit** |
| No commits ahead (empty diff) | Skip this step, **continue** the pipeline |

`waitFor`: after the PR merges, poll each workflow until success (timeout ~45 minutes).

**Merge when checks succeed**

- **Gitea:** native `merge_when_checks_succeed`
- **GitHub:** enables **auto-merge** on the PR. Turn on “Allow auto-merge” in the repo settings first, or the step fails with a clear error.

#### `run-workflow`

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

**Runtime checks:** `ref` branch exists; workflow file exists at that ref.

---

## `eager` and `needConfirmation`

| Flag | Meaning |
|------|---------|
| `eager: true` on **run-workflow** | Collect dispatch inputs **before** the step loop. Saved to `history.jsonc` **immediately** when you answer. |
| `eager: true` on **create-pr** | Ask the create-pr confirm **up front** (Yes / Skip / Change source). |
| `needConfirmation: true` | Confirm before running. create-pr: Yes / Skip / Change. run-workflow: Yes / No. Skip → continue the pipeline. |

- `needConfirmation` + `eager` → confirm once at the start
- `needConfirmation` only → confirm when that step’s turn arrives
- Confirm Yes/Skip answers are **never** stored in history (source branch text is)

---

## History (`history.jsonc`)

- Gitignored.
- Last-used `workflow_dispatch` inputs per repo + workflow name.
- Last `sourceBranch` string per repo (single value, overwritten).
- Workflow inputs written on eager answer and after successful dispatch.
- Written as `JSON.stringify` plus a `// Auto-updated by gitrung…` header (read back with `Bun.JSONC.parse`).

---

## How files are parsed

| What | How |
|------|-----|
| `config.jsonc` / `history.jsonc` | `Bun.JSONC.parse` (comments + trailing commas). Config validated with Zod (`AppConfigSchema`). |
| Workflow YAML (dispatch inputs) | `Bun.YAML.parse` then Zod (`WorkflowDocSchema`). No third-party `yaml` package. |
| Git host API JSON (PRs, file contents, compare) | Zod schemas (`PullRequestSchema`, `ContentFileSchema`, `CompareResultSchema`, …) after `JSON.parse`. |
| Workflow run list payloads | Loose Zod `safeParse` then normalize (bad shapes → skip / empty). |

---

## Example flow (retailr-server)

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
| `.env` | `GITEA_TOKEN` / `GITHUB_TOKEN` (gitignored) |
| `history.jsonc` | Past workflow inputs (gitignored) |
| `src/` | CLI source |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Config not found / empty | `cp config.jsonc.example config.jsonc` then edit |
| `gitPlatform` missing | Add `"gitPlatform": "gitea"` or `"github"` on each repo |
| `doctor` fails | Fix the reported Zod / parse errors |
| Zod error on API / workflow YAML | Message includes a field path — fix the remote file or report a host shape quirk |
| Gitea 403 | Token needs `write:repository` |
| GitHub 403 | Token needs `repo` + `workflow` |
| GitHub auto-merge error | Enable Allow auto-merge in the repo settings |
| Stuck on “waiting for workflow” | Check the workflow file name; open the run URL in the UI |
| Branch not found | Fix the name in config / prompt; create the branch on the remote |
| Workflow file not found | File must exist under workflows dir on that ref |
| Open PR exists → tool exits | Expected. Close/merge that PR or change branches in config |

Next: run `bun run doctor`, then `bun start`.
