# Analyze PR Size

PR Size Analyzer is a GitHub Action that summarizes pull request size and posts (or updates) a single PR comment.

It answers one question:

How big is this PR, really?

The action is advisory. It does not block merges.

---

## What It Does

On pull request events, it:
- counts changed files
- totals additions and deletions
- computes total lines changed
- classifies the PR size (XS / S / M / L / XL)
- posts or updates a single PR comment with the summary

---

## Example Output

PR Size Summary

Files changed: 27  
Lines added: +812  
Lines removed: -144  
Total changed: 956

Size: XL

---

## Usage

```yaml
name: Analyze PR Size

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: read
  issues: write

jobs:
  size:
    runs-on: ubuntu-latest
    steps:
      - name: Analyze PR size
        uses: lukekania/analyze-pr-size@v0.1.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Configuration

| Input | Default | Description |
|------|---------|-------------|
| max_files | 500 | Max PR files to inspect |
| xs_lines | 50 | XS upper bound (lines changed) |
| s_lines | 200 | S upper bound |
| m_lines | 500 | M upper bound |
| l_lines | 1000 | L upper bound |
| xs_files | 2 | XS upper bound (files changed) |
| s_files | 5 | S upper bound |
| m_files | 15 | M upper bound |
| l_files | 30 | L upper bound |
| add_label | false | Add a `size:XS` … `size:XL` label to the PR |
| step_summary | false | Write the size summary to the GitHub Actions Step Summary |
| ignore_patterns | `dist/**,*.min.js,*.min.css,package-lock.json,yarn.lock,pnpm-lock.yaml,*.generated.*` | Comma-separated glob patterns for generated/lock files to exclude from size calculation |

Classification uses the larger of:
- file bucket, and
- line-change bucket

This prevents “many files, few lines” PRs from being mislabeled as small.

---

## Outputs

| Output | Description |
|--------|-------------|
| `size` | Computed size bucket (`XS`, `S`, `M`, `L`, `XL`) |
| `total_lines` | Total lines changed (additions + deletions) |
| `file_count` | Number of files changed |
| `pr_age_hours` | PR age in hours since creation |

Use these outputs to build analytics dashboards or drive downstream workflow decisions (e.g., require extra approvals for XL PRs).

---

## License

MIT
