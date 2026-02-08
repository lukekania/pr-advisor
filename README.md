# PR Advisor

PR Advisor is a unified GitHub Action that combines PR size analysis, state explanation, and reviewer suggestions into a single PR comment.

Instead of three separate actions and three comments, you get one.

---

## What It Does

On pull request events, the action can:

**Size Analysis** — classify the PR (XS–XL) by files and lines changed, show top directories, and recommend splits for large PRs.

**State Explanation** — explain why a PR is stalled: failing checks, pending reviews, merge conflicts, staleness.

**Reviewer Suggestions** — rank reviewer candidates using commit history, CODEOWNERS, review latency, timezone, and load.

Each section can be independently enabled or disabled.

---

## Example Output

### PR Advisor

---
#### Size Summary

Files changed: **27**

Lines added: **+812**
Lines removed: **-144**
Total changed: **956**

Size: **XL**

---
#### PR State

**Last activity:** 6 days ago
**Draft:** no
**Mergeable:** yes

**Checks:**
- failing: `lint`, `test`
- totals: 3 success | 2 failure

**What's blocking this PR:**
- CI failing: `lint`, `test`
- No PR activity in **6 days**

---
#### Reviewer Suggestions

- @alice (score: 14) — CODEOWNERS, recent commits
- @bob (score: 9) — fast reviewer, recent commits

---

## Usage

```yaml
name: PR Advisor

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read

jobs:
  advise:
    runs-on: ubuntu-latest
    steps:
      - name: PR Advisor
        uses: lukekania/analyze-pr-size@v1.0.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Stale Sweep (scheduled)

```yaml
on:
  schedule:
    - cron: '0 9 * * 1-5'

jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - uses: lukekania/analyze-pr-size@v1.0.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          sweep_stale: true
```

---

## Configuration

### Global

| Input | Default | Description |
|-------|---------|-------------|
| dry_run | false | Log the comment body but do not post it |
| step_summary | false | Write the summary to GitHub Actions Step Summary |
| enable_size | true | Enable the size analysis section |
| enable_state | true | Enable the state explanation section |
| enable_reviewer | true | Enable the reviewer suggestion section |

### Size

| Input | Default | Description |
|-------|---------|-------------|
| max_files | 500 | Max PR files to inspect |
| add_label | false | Add a `size:XS` … `size:XL` label to the PR |
| ignore_patterns | `dist/**,*.min.js,...` | Comma-separated globs for files to exclude |
| xs_lines / s_lines / m_lines / l_lines | 50 / 200 / 500 / 1000 | Line-count thresholds |
| xs_files / s_files / m_files / l_files | 2 / 5 / 15 / 30 | File-count thresholds |

### State

| Input | Default | Description |
|-------|---------|-------------|
| stale_days | 3 | Days without activity before PR is stale |
| comment_only_when_stale | false | Only comment when PR is stale |
| max_checks | 50 | Maximum checks to inspect |
| stale_overrides | | JSON map of label to custom stale days |
| review_latency | false | Show how long reviews have been pending |
| language | en | Comment language (`en`, `de`, `es`) |
| sweep_stale | false | Scan all open PRs for staleness |
| max_prs | 50 | Max PRs to scan during stale sweep |

### Reviewer

| Input | Default | Description |
|-------|---------|-------------|
| max_reviewers | 3 | Maximum reviewers to suggest |
| lookback_days | 90 | Commit history lookback |
| reviewer_max_files | 50 | Max changed files for reviewer analysis |
| use_codeowners | true | Boost CODEOWNERS matches |
| use_latency | true | Boost fast reviewers |
| latency_prs | 20 | PRs sampled for latency |
| penalize_load | true | Penalize candidates with many open reviews |
| exclude_reviewers | | Comma-separated reviewers to exclude |
| cross_repo_list | | Comma-separated repos for cross-repo expertise |
| required_reviewers | | Comma-separated must-include reviewers |
| prefer_timezone | | Preferred timezone offset (e.g., `UTC+1`) |
| show_breakdown | false | Show signal breakdown table |
| detect_flaky | false | Detect and penalize flaky reviewers |

---

## Outputs

| Output | Description |
|--------|-------------|
| size | Computed size bucket (XS, S, M, L, XL) |
| total_lines | Total lines changed |
| file_count | Number of files changed |
| pr_age_hours | PR age in hours since creation |
| suggestions_json | JSON array of reviewer suggestions (dry_run only) |

---

## Migration from Individual Actions

PR Advisor replaces three separate actions:

- `analyze-pr-size` → `enable_size: true` (default)
- `explain-pr-state` → `enable_state: true` (default)
- `suggest-reviewer` → `enable_reviewer: true` (default)

On first run, old comments from the individual actions are automatically cleaned up.

The `max_files` input from `suggest-reviewer` is now `reviewer_max_files` to avoid conflict with the size analysis `max_files`.

---

## Design Principles

- One comment, not three
- Advisory, not blocking
- Heuristics over ML
- Each section independently toggleable
- Old comments cleaned up automatically

---

## License

MIT
