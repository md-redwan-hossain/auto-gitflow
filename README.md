# gitrung

**gitrung** is an interactive release helper for GitHub and Gitea. Describe a repository’s pull-request and workflow actions in JSONC, then run them in a guided order.

| Tool | What it does |
| --- | --- |
| `list-pr` | Lists pull requests, optionally limited to one author. |
| `create-pr` | Creates a pull request and can merge it after checks pass. |
| `merge-pr` | Merges an existing pull request after its checks pass. |
| `run-workflow` | Dispatches a repository workflow on a selected ref. |
| Step group | Lets the user select one action from several alternatives. |

## Start here

1. Download the binary for your platform from the [releases page](https://github.com/md-redwan-hossain/gitrung/releases).
2. Create a folder and place the binary inside it. Create `configs` and `.env` alongside the binary:

```text
gitrung/
├── gitrung                 # macOS/Linux binary
├── gitrung.exe             # Windows binary
├── .env
└── configs/
    └── storefront.jsonc
```

3. Copy `configs/my-repo.jsonc.example` to `configs/storefront.jsonc`, then replace the dummy values.
4. Add the matching token to `.env`:

```sh
# GitHub: repository and workflow access
GITHUB_TOKEN=your_token

# Gitea
GITEA_TOKEN=your_token
```

5. Open a terminal in `gitrung`, then check and run it:

```sh
./gitrung doctor
./gitrung --repo storefront
```

> On Windows, use `.\gitrung.exe` instead of `./gitrung`.

### Run from anywhere

Rename the macOS/Linux binary to `gitrung` (keep the `.exe` extension on Windows), then add the `gitrung` folder to your system `PATH`. You can now run:

```sh
gitrung doctor
gitrung --repo storefront
```

When running outside the `gitrung` folder, either keep a `configs` folder and `.env` in your current directory or explicitly choose the config directory:

```sh
gitrung doctor --config /path/to/gitrung/configs
gitrung --repo storefront --config /path/to/gitrung/configs
```

> A config’s **label is its filename**. `configs/storefront.jsonc` is selected with `--repo storefront`; do not add a `label` property.

## Full example


```jsonc
{
  "url": "https://git.example.test/acme/storefront",
  "gitPlatform": "gitea",
  "steps": [
    {
      "type": "list-pr",
      "status": "open",
      "user": "alex",
      "bypassEager": true,
    },
    {
      "eager": true,
      "subSteps": [
        {
          "type": "create-pr",
          "sourceBranch": "feature/catalog",
          "destinationBranch": "staging",
          "title": "Promote catalog changes to staging",
          "body": "Prepare the catalog release for staging.",
          "merge": true,
          "eager": true,
          "needConfirmation": true,
          "afterMerge": {
            "waitFor": [
              "build-staging.yaml",
            ],
          },
        },
        {
          "type": "merge-pr",
          "when": [
            {
              "destinationBranch": "staging",
              "waitFor": [
                "build-staging.yaml",
              ],
            },
          ],
        },
      ],
    },
    {
      "type": "run-workflow",
      "workflow": "deploy-staging.yaml",
      "ref": "staging",
      "eager": true,
      "needConfirmation": true,
      "waitUntilFinish": true,
      "exitOnError": true,
    },
    {
      "type": "create-pr",
      "sourceBranch": "staging",
      "destinationBranch": "production",
      "title": "Promote staging to production",
      "body": "Release storefront changes to production.",
      "merge": true,
      "eager": true,
      "needConfirmation": true,
      "afterMerge": {
        "waitFor": [
          "build-production.yaml",
        ],
      },
    },
    {
      "type": "run-workflow",
      "workflow": "deploy-production.yaml",
      "ref": "production",
      "eager": true,
      "needConfirmation": true,
      "waitUntilFinish": true,
      "exitOnError": true,
    },
  ],
}
```

## Commands

| Command | Why use it | Example |
| --- | --- | --- |
| `gitrung` | Run a repository’s configured release flow. Prompts for a repo when there is more than one. | `gitrung --repo storefront` |
| `gitrung doctor` | Same health checks as a normal run: IO access (configs/`.env` read, metadata/upgrade write) plus parse and validate every config. | `gitrung doctor --config ./configs` |
| `gitrung upgrade` | Check for and install the latest compiled executable. | `gitrung upgrade` |

## Repository properties

| Property | Required | Meaning | Example |
| --- | --- | --- | --- |
| `url` | Yes | Repository URL. | `https://git.example.test/acme/storefront` |
| `gitPlatform` | Yes | API provider: `github` or `gitea`. | `"gitea"` |
| `steps` | Yes | Ordered actions to run; at least one is required. | An array of step objects. |

## Step tools

### `list-pr`

Use it to review pull requests before continuing. It can run before all eager questions, which makes it useful as the first step.

```jsonc
{
  "type": "list-pr",
  "status": "open",
  "user": "alex",
  "bypassEager": true,
}
```

```mermaid
flowchart TD
    A[Start pipeline] --> B[Fetch PRs by status]
    B --> C{User filter set?}
    C -->|Yes| D[Keep matching author]
    C -->|No| E[Show all fetched PRs]
    D --> F[Show matching PRs]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `"list-pr"`. |
| `status` | Yes | PR state: `open`, `closed`, or `all`. |
| `user` | No | Show only PRs authored by this login. |
| `bypassEager` | No | Run this top-level step before eager prompts. Defaults to `false`. |

### `create-pr`

Use it to create a PR. With `merge: true`, gitrung schedules the merge after checks pass, waits for it, then can wait for named workflows on the destination branch.

```jsonc
{
  "type": "create-pr",
  "sourceBranch": "staging",
  "destinationBranch": "production",
  "title": "Promote staging to production",
  "body": "Release storefront changes to production.",
  "merge": true,
  "eager": true,
  "needConfirmation": true,
  "afterMerge": {
    "waitFor": [
      "build-production.yaml",
    ],
  },
}
```

```mermaid
flowchart TD
    A[Validate source and destination] --> B{Commits ahead?}
    B -->|No| C[Skip: nothing to merge]
    B -->|Yes| D[Create PR]
    D --> E{merge is true?}
    E -->|No| F[Leave PR open]
    E -->|Yes| G[Schedule merge after checks]
    G --> H[Wait for merge and workflows]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `"create-pr"`. |
| `sourceBranch` | No | Branch to promote. When omitted, gitrung asks for it. |
| `destinationBranch` | Yes | Branch that receives the PR. |
| `title` | No | PR title. A descriptive default is generated when omitted. |
| `body` | No | PR body. A default is generated when omitted. |
| `merge` | Yes | `true` schedules merge after checks; `false` leaves the new PR open. |
| `afterMerge` | When `merge` is `true` | Post-merge wait settings; not allowed when `merge` is `false`. |
| `afterMerge.waitFor` | Yes with `afterMerge` | Workflow filenames to wait for successfully on the destination branch. An empty list is allowed. |
| `eager` | No | Collect this step’s early confirmation/input during preflight. Defaults to `false`. |
| `needConfirmation` | No | Let the user run or skip this action. Defaults to `false`. |

### `merge-pr`

Use it when someone already opened the PR. gitrung asks for the PR number, verifies it is open and mergeable, waits for checks, merges it, and optionally waits for follow-up workflows.

```jsonc
{
  "type": "merge-pr",
  "when": [
    {
      "destinationBranch": "staging",
      "waitFor": [
        "build-staging.yaml",
      ],
    },
  ],
}
```

```mermaid
flowchart TD
    A[Enter PR number] --> B[Validate open and mergeable]
    B --> C[Wait for PR checks]
    C --> D[Merge PR]
    D --> E{Matching when rule?}
    E -->|Yes| F[Wait for named workflows]
    E -->|No| G[Finish]
    F --> G
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `"merge-pr"`. |
| `when` | No | Rules for post-merge workflow waits. Defaults to `[]`. |
| `when[].destinationBranch` | Yes per rule | Apply this rule when the PR targets this branch. |
| `when[].waitFor` | Yes per rule | One or more workflow filenames that must succeed after the merge. |

### `run-workflow`

Use it to manually dispatch a workflow file on a branch. If its `workflow_dispatch` definition has inputs, gitrung prompts for them and remembers the most recent values per repository and workflow.

```jsonc
{
  "type": "run-workflow",
  "workflow": "deploy-staging.yaml",
  "ref": "staging",
  "eager": true,
  "needConfirmation": true,
  "waitUntilFinish": true,
  "exitOnError": true,
}
```

```mermaid
flowchart TD
    A[Validate ref and workflow file] --> B[Read workflow inputs]
    B --> C[Reuse or enter values]
    C --> D[Dispatch workflow]
    D --> E{waitUntilFinish?}
    E -->|Yes| F[Wait for successful run]
    E -->|No| G[Finish]
    F --> G
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `"run-workflow"`. |
| `workflow` | Yes | Workflow filename in the platform workflow directory. |
| `ref` | Yes | Branch or ref on which to dispatch it. |
| `eager` | Yes | Collect workflow inputs during preflight instead of at this point in the flow. |
| `needConfirmation` | No | Let the user run or skip it. Defaults to `false`. |
| `waitUntilFinish` | No | Wait for the dispatched workflow to succeed. Defaults to `false`. |
| `exitOnError` | No | Stop the pipeline when dispatch or waiting fails. Defaults to `true`. |

### Step group

A group is not an action itself. It presents its `subSteps` and runs exactly one choice. Use it to offer “create a PR” **or** “merge an existing PR” without executing both.

```jsonc
{
  "eager": true,
  "subSteps": [
    {
      "type": "create-pr",
      "sourceBranch": "feature/catalog",
      "destinationBranch": "staging",
      "title": "Promote catalog changes to staging",
      "body": "Prepare the catalog release for staging.",
      "merge": false,
      "eager": true,
      "needConfirmation": true,
    },
    {
      "type": "merge-pr",
      "when": [
        {
          "destinationBranch": "staging",
          "waitFor": [
            "build-staging.yaml",
          ],
        },
      ],
    },
  ],
}
```

```mermaid
flowchart TD
    A[Show sub-step choices] --> B{User selects one}
    B --> C[Run selected sub-step]
    C --> D[Continue next top-level step]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `eager` | No | Ask the user to choose the path during preflight. Defaults to `false`. |
| `subSteps` | Yes | Two or more non-group steps. Nested groups are not supported. |

## Practical rules

- Config files may be `.jsonc` or `.json`; comments and trailing commas work in JSONC.
- Workflow filenames are validated remotely before gitrung uses them.
- `metadata.jsonc` keeps the history from previous runs, including recently used workflow inputs and source branches.
- A normal run and `doctor` share the same health checks (IO permissions plus config validation); run `doctor` after editing a config to catch problems early.
