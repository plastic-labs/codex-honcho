# Bootstrap Existing Codex Memory

This optional workflow is for users who already have local Codex memory under
`~/.codex/memories` and want to seed Honcho with reviewed conclusions.

It is intentionally separate from `codex-honcho install`. Installation captures
future sessions; bootstrapping legacy memory is a migration step that should be
reviewed before any upload.

## Safety Contract

- Do not upload raw transcripts or whole memory files.
- Generate a dry run first.
- Review the staged conclusions before writing to Honcho.
- Require an explicit approval flag or equivalent confirmation before upload.
- Treat old live facts, counts, deadlines, prices, and verification claims as
  stale unless revalidated.
- Keep low-priority routing/topic-index rows out of the first import unless the
  user explicitly wants broad search routing.

## Recommended Import Shape

Use concise conclusions such as:

- durable user preferences
- project conventions and source-of-truth rules
- recurring local machine or toolchain gotchas
- failure patterns with known fixes
- curated learnings from `memory_summary.md`

Avoid:

- raw session messages
- unreviewed rollout summaries
- stale "it works" claims without the original date
- generated artifacts that were meant only for a one-off task

## Suggested Sets

| Set | Includes | Use when |
| --- | --- | --- |
| `core` | global preferences plus the highest-signal reusable rules | you want the smallest first import |
| `high` | high-priority preferences, tips, and curated learnings | you want a conservative import |
| `high-medium` | high plus repo facts and failure/fix patterns | you want a useful first bootstrap |
| `full` | everything above plus low-priority topic routes | you want Honcho to act as a broad memory router |

The recommended first import is usually `high-medium`.

## Preserve Chronology

Honcho conclusion `createdAt` is the upload time. Do not try to backdate it.

Instead, preserve source chronology in the conclusion text or metadata that your
importer stages for review:

```text
Use `web/` as the JobBot build surface; the repository root has no package.json.
[Source memory date: 2026-06-17; basis: latest rollout evidence.]
```

Common date sources:

- `rollout_summaries/YYYY-MM-DD...` filenames
- dated headings in `memory_summary.md`
- the memory-summary snapshot date for global profile/preference rows

## Route Sessions Deliberately

For project-specific conclusions, route to the same session naming strategy that
`codex-honcho` uses:

- `per-directory`: `basename(cwd)`
- `git-branch`: `basename(cwd)-branch`
- explicit `sessions[cwd]` overrides from `~/.honcho/config.json`

Global preferences should remain unscoped peer conclusions.

## Preflight Before Upload

Before creating conclusions, compare the staged upload text against existing
Honcho conclusions and skip exact matches.

When checking a large conclusion set, do not rely on a single paginated list
pass if ordering is unstable. A safer preflight can union multiple list orders
or use targeted lookups for representative rows.

## Review Checklist

Before upload, confirm:

- the import set is intentionally scoped (`core`, `high`, `high-medium`, or
  `full`)
- every row has clean review text and exact upload text
- project rows have the intended Honcho session id
- source dates are present for old conclusions
- exact duplicates are skipped
- upload is impossible without explicit user approval

