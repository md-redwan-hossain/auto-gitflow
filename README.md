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
cp configs/my-repo.jsonc.example configs/my-repo.jsonc
```

3. Put tokens in `.env`:

```env
GITEA_TOKEN=your_gitea_token
GITHUB_TOKEN=your_github_token
```

Only set the token(s) for platforms you use.

- **Gitea:** repository Read and Write (`write:repository`)
- **GitHub:** classic PAT with `repo` + `workflow` (or fine-grained: contents, pull requests, actions, and metadata)

4. Edit files under `configs/`. Every repo needs `"gitPlatform": "gitea"` or `"github"`. The filename stem is the repo label (e.g. `retailr-server.jsonc` → `-r retailr-server`).

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
| `bun start -- -r <label>` | Skip the repo picker (label = filename stem) |
| `bun start -- -c path/to/configs` | Use another configs directory |
| `bun run doctor` | Parse + validate configs (no API token needed) |
| `gitrung upgrade` | Check for and install the latest compiled binary |
| `bun run typecheck` | TypeScript check |

---

## Release (binaries)

Run **Actions → Release → Run workflow** to rebuild and upload a rolling GitHub Release named `latest` (manual only; not on every push).

| Platform | Asset |
|----------|--------|
| Windows x64 | [gitrung-windows-x64.exe](https://github.com/md-redwan-hossain/gitflow-automation/releases/latest/download/gitrung-windows-x64.exe) |
| Linux x64 | [gitrung-linux-x64](https://github.com/md-redwan-hossain/gitflow-automation/releases/latest/download/gitrung-linux-x64) |
| macOS Apple Silicon | [gitrung-darwin-arm64](https://github.com/md-redwan-hossain/gitflow-automation/releases/latest/download/gitrung-darwin-arm64) |
| macOS Intel | [gitrung-darwin-x64](https://github.com/md-redwan-hossain/gitflow-automation/releases/latest/download/gitrung-darwin-x64) |

Run the binary from a folder that has `configs/` (cwd), or pass `-c path/to/configs`.

Run `gitrung upgrade` to compare the installed compiled binary with the matching
platform asset in the public `latest` release. The command asks before updating
and verifies the downloaded binary against its published SHA-256 checksum. If
the checksum asset is missing or invalid, it refuses to update. Source mode
(`bun src/index.ts upgrade`) cannot self-update; use a compiled binary.

---

## Config (`configs/`)

- Default path is `./configs` under the **current working directory**. Run from the project folder, or pass `-c path/to/configs` (needed for a compiled binary if cwd is elsewhere).
- One file per repo: `configs/<label>.jsonc` or `configs/<label>.json`.
- **Gitignored** (`*.jsonc` / `*.json`). Copy from `configs/my-repo.jsonc.example`.
- Only `.jsonc` and `.json` are loaded; everything else (including `*.example`) is ignored.
- Each file is a **single repo object** (not an array). Label comes from the filename — do not put `label` in the file.
- Missing dir / no loadable files → tool warns and exits.
- Steps run **in array order** for the selected repo.
- **Do not** infer platform from the URL — set `gitPlatform` yourself.
- JSONC: comments and trailing commas are fine (`Bun.JSONC.parse`).

### Repo shape

```jsonc
// configs/my-repo.jsonc
{
  "url": "https://git.example.com/org/repo",
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
  "user": "redwan",   // optional: author login
  "bypassEager": true // optional: run before eager prompts
}
```

`bypassEager: true` → runs **before** eager create-pr / workflow prompts, then is skipped in the normal step loop (not run twice). Default `false`.

#### `create-pr`

```jsonc
{
  "type": "create-pr",
  // "sourceBranch": "redwan",   // optional — if omitted, prompt (+ history)
  "destinationBranch": "develop",
  "merge": true,
  "afterMerge": {
    "waitFor": ["develop-branch-docker.yaml"]  // empty [] allowed
  },
  "eager": false,
  "needConfirmation": false
}
```

**`sourceBranch`**

- Optional. If missing → prompt (reuse last value from `metadata.jsonc` if any) → save that one string per repo (overwrite, not a list).
- With `needConfirmation: true` → **Yes** / **Skip** / **Change source branch** (not a plain Yes/No). Change re-prompts, saves history, asks again.
- If config `sourceBranch` is set **and** history has a different value for that dest → a 3rd option **Use from history (`demo → develop`)** appears; Change stays last.

**`merge` / `afterMerge`**

- `merge: true` → schedule merge when checks succeed, then run `afterMerge.waitFor`. `afterMerge` is required (`waitFor` may be `[]`).
- `merge: false` → create PR only; do not include `afterMerge`.
- Immediate merge from create-pr is not supported — use `merge-pr`.

**Runtime checks (before create)**

- Source and destination branches exist on the remote
- When `merge: true`, each `afterMerge.waitFor` workflow file exists at `destinationBranch` under `.gitea/workflows/` or `.github/workflows/`

| Situation | Behavior |
|-----------|----------|
| Open PR already exists (same branches) | Warn and **exit** — does not touch that PR |
| Create returns duplicate / 409 | Same — **exit** |
| No commits ahead (empty diff) | Skip this step, **continue** the pipeline |
| Merge conflicts after create (`mergeable: false`) | **Abort** (exit 1) before merge |

`afterMerge.waitFor`: after the PR merges, poll each workflow until success (timeout ~45 minutes).

**Merge when checks succeed** (only when `merge: true`)

- **Gitea:** native `merge_when_checks_succeed`
- **GitHub:** enables **auto-merge** on the PR. Turn on “Allow auto-merge” in the repo settings first, or the step fails with a clear error.

#### `merge-pr`

Merge an already-open PR by number. The step **waits for running checks to finish**, then merges immediately.

```jsonc
{
  "type": "merge-pr",
  "when": [
    {
      "destinationBranch": "develop",
      "waitFor": ["develop-branch-docker.yaml"]
    }
  ]
}
```

- Prompts for a PR number (during eager preflight when selected under an eager `subSteps` group).
- Validates: PR exists, is open (not closed/merged), no merge conflicts.
- Waits for commit checks on the PR head; fails if checks fail.
- **`when`:** array of `{ destinationBranch, waitFor }` — **empty `[]` allowed**. Each entry’s `waitFor` must be non-empty. After load, match `pr.base` to `destinationBranch`; on match, wait for those workflows after merge. No match / empty `when` → merge only (no post-merge waits).

#### `subSteps` (exclusive group)

One nesting level only: `steps → subSteps`. Parent has **no `type`** — only `eager` + `subSteps` (min 2 leaf steps). You pick **one** child to run.

```jsonc
{
  "eager": true,
  "subSteps": [
    {
      "type": "create-pr",
      "sourceBranch": "redwan",
      "destinationBranch": "develop",
      "merge": true,
      "afterMerge": {
        "waitFor": ["develop-branch-docker.yaml"]
      },
      "eager": true,
      "needConfirmation": true
    },
    {
      "type": "merge-pr",
      "when": [
        {
          "destinationBranch": "develop",
          "waitFor": ["develop-branch-docker.yaml"]
        }
      ]
    }
  ]
}
```

- Group `eager: true` → pick which child **during eager preflight**, then apply that child’s leaf eager rules (create-pr confirm, workflow inputs, merge-pr PR#).
- Group without `eager` → pick when the group’s turn arrives.
- Nested `subSteps` are not allowed.

#### `run-workflow`

```jsonc
{
  "type": "run-workflow",
  "workflow": "staging-deploy.yaml",
  "ref": "develop",
  "eager": true,
  "needConfirmation": true,
  "waitUntilFinish": true,
  "exitOnError": true
}
```

If the workflow YAML has inputs, you are prompted (YAML defaults + history). If it has no inputs, it dispatches with `{}`.

| Flag | Default | Meaning |
|------|---------|---------|
| `waitUntilFinish` | `false` | After dispatch, poll until the workflow run succeeds before the next step. |
| `exitOnError` | `true` | On dispatch or wait failure, stop the pipeline. Set `false` to log the error and continue. |

**Runtime checks:** `ref` branch exists; workflow file exists at that ref.

---

## `eager` and `needConfirmation`

| Flag | Meaning |
|------|---------|
| `bypassEager: true` on **list-pr** | List PRs **before** any eager prompts. |
| `eager: true` on a **subSteps** group | Pick which child **up front**, then run that child’s leaf eager prompts. |
| `eager: true` on **run-workflow** | Collect dispatch inputs **before** the step loop. Saved to `metadata.jsonc` **immediately** when you answer. |
| `eager: true` on **create-pr** | Ask the create-pr confirm **up front** (Yes / Skip / [Use from history] / Change). |
| `needConfirmation: true` | Confirm before running. create-pr: Yes / Skip / [Use from history] / Change. run-workflow: Yes / Skip. Skip → continue the pipeline. |

- Order: `bypassEager` list-pr → eager group picks → eager confirms/inputs → remaining steps
- Group-level `eager` is only meaningful with `subSteps` (one level deep).
- `needConfirmation` + `eager` → confirm once at the start
- `needConfirmation` only → confirm when that step’s turn arrives
- Confirm Yes/Skip answers are **never** stored in history (source branch text is)

---

## Metadata (`metadata.jsonc`)

- Gitignored. Header: `// Auto-updated by gitrung.`
- `workflowLogs`: keyed by repo label (filename stem) → array of `{ name, lastUsed }` (no nested `workflows` / no `repoUrl`).
- `sourceBranches`: keyed by `label:create-pr:dest` → source branch string (e.g. `retailr-server:create-pr:develop`).
- Workflow inputs written on eager answer and after successful dispatch.
- Written as `JSON.stringify` plus the header (read back with `Bun.JSONC.parse`).

---

## How files are parsed

| What | How |
|------|-----|
| `configs/*.jsonc` / `configs/*.json` / `metadata.jsonc` | `Bun.JSONC.parse` (comments + trailing commas). Each repo file validated with Zod (`RepoFileSchema`); label from filename. |
| Workflow YAML (dispatch inputs) | `Bun.YAML.parse` then Zod (`WorkflowDocSchema`). No third-party `yaml` package. |
| Git host API JSON (PRs, file contents, compare) | Zod schemas (`PullRequestSchema`, `ContentFileSchema`, `CompareResultSchema`, …) after `JSON.parse`. |
| Workflow run list payloads | Loose Zod `safeParse` then normalize (bad shapes → skip / empty). |

---

## Example flow (retailr-server)

1. List open PRs (`bypassEager`)
2. Eager `subSteps`: pick **create-pr** or **merge-pr** for develop (plus that child’s prompts)
3. Confirm + dispatch staging deploy (inputs collected early)
4. Confirm + PR `develop` → `main`, wait for main docker
5. Dispatch production deploy (inputs already collected + in history)

---

## Files you care about

| File | Role |
|------|------|
| `configs/<label>.jsonc` | Your steps per repo (local, gitignored) |
| `configs/my-repo.jsonc.example` | Template to copy |
| `.env` | `GITEA_TOKEN` / `GITHUB_TOKEN` (gitignored) |
| `metadata.jsonc` | Past workflow inputs (gitignored) |
| `src/` | CLI source |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Config not found / empty | `cp configs/my-repo.jsonc.example configs/my-repo.jsonc` then edit |
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
