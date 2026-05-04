---
name: mindcraft-code-review
description: Run a structured code review of the Mindcraft Minecraft-bot repo. Produces a categorized findings report (severity + effort + type), prints a summary to the terminal, and writes the full report to docs/code-review/<timestamp>.md. Use this skill whenever the user asks for a "code review", "audit the codebase", "review my branch", "check for bugs", "review the changes", "look over my code", "code health check", "find issues in the bot", or anything similar — even when they don't say the word "skill". Also trigger when the user asks to find performance regressions, design problems, fragile code, or things that need refactoring in the bot. Supports two modes: a full-repo audit, or a branch-only review (only files that differ from main).
---

# Mindcraft Code Review

You are running a structured code review of the Mindcraft Minecraft-bot repository at `D:\repos\mindcraft`. The bot is a multi-LLM Mineflayer-based agent. The deliverable is a findings report, written to a markdown file AND summarized in the chat for the user. This skill is intentionally Mindcraft-specific so it can lean into the architecture rather than re-deriving it every run.

## What the user gets

1. A short **terminal summary** (in your chat reply): the headline counts, the top 3-5 highest-severity findings, a link to the full report file. Keep this under ~25 lines so it's scannable.
2. A **full report** at `docs/code-review/<UTC-timestamp>.md` (e.g. `docs/code-review/2026-05-01T14-22.md`) with every finding rendered using the template in `references/findings-template.md`.

Both outputs are required — never skip the file write, and never skip the terminal summary.

## Workflow

Run these phases in order. Each phase has a clear output you carry into the next.

### Phase 1 — Determine scope

Look at the user's message:

- If they said "branch", "this branch", "my changes", "the diff", "uncommitted", "what I just did", or similar → **branch mode**. Run `git diff --name-only main...HEAD` (and `git diff --name-only` and `git diff --name-only --cached` for unstaged/staged) to assemble the in-scope file list. If the bot's main branch isn't called `main`, fall back to whatever the default branch is (`git symbolic-ref refs/remotes/origin/HEAD` if needed).
- If they said "full review", "whole repo", "audit everything", or didn't specify → **full mode**. Scope = every source file under `src/`, `main.js`, and the contents of `tests/`.
- If ambiguous, ask the user once with a short either/or question. Don't ask more than once.

Always print the resolved scope (mode + count of files in scope) to the terminal before going further.

### Phase 2 — Refresh the project index

Read `references/mindcraft-architecture.md` to load the baked-in component map. Then quickly verify it against the live `src/` tree (use Glob to confirm key files still exist where the reference says they do). If something has clearly drifted (a subsystem moved, a file disappeared, a major new file appeared), note it as a finding under the "Architecture drift" type and proceed using current reality.

The architecture reference is the **index** the user asked for. The terminal summary should include a one-paragraph version of it; the full report includes the long version.

### Phase 3 — Identify the hot-spots in scope

Read `references/hot-spots.md`. Cross-reference it with your in-scope file list. Anything in scope that's also a hot-spot gets extra review attention in Phase 4. Keep a running list of "hot-spots in scope" — both the report and the summary surface this.

### Phase 4 — Review the code

Spawn parallel review subagents to read and critique the in-scope code. The parallelism is important because reviewing the whole repo serially is slow and burns tokens on context-switching. Use the `Task` / `Agent` tool with the `general-purpose` subagent type.

Group files by subsystem and dispatch ~3-5 subagents at once, e.g.:

- **Agent loop & history**: `src/agent/agent.js`, `src/agent/history.js`, `src/agent/action_manager.js`, `src/agent/self_prompter.js`, `src/agent/modes.js`
- **Commands & objectives**: `src/agent/commands/`, `src/agent/objectives/`, `src/agent/coder.js`
- **Prompter & models**: `src/models/prompter.js`, `src/models/_model_map.js`, plus a sample of provider adapters
- **Memory, vision, library**: `src/agent/memory_bank.js`, `src/agent/transcript_logger.js`, `src/agent/vision/`, `src/agent/library/`
- **Tests & infra** (if in scope): `test/`, `tools/`, `main.js`, `settings.js`

Brief each subagent with the same template (see "Subagent brief" below). Each subagent returns a JSON array of findings using the schema in `references/findings-template.md`. If you only have a small in-scope set (branch mode with a handful of files), one subagent or even an inline review is fine — don't over-engineer it.

Each finding must include:

- `id` (will be assigned later, leave as null in subagent output)
- `title` (one line, ≤80 chars)
- `severity` — exactly one of `small-fix` or `major-revision`
- `effort` — exactly one of `<30min`, `1-4h`, `1-2d`, `>1wk`
- `type` — one of `bug-risk`, `correctness`, `design`, `perf`, `cost`, `readability`, `security`, `architecture-drift`
- `where` — `path/to/file.ext:start-end` with a real line range
- `symptom` — what's there now (1-3 sentences)
- `why` — why it matters in *this* bot's context (1-3 sentences, concrete)
- `fix` — what to change (1-3 sentences, actionable)
- `verify` — how to confirm the fix works (1-2 sentences: a test name to add, a metric to check, a transcript line to look for)

### Phase 5 — Merge, dedupe, rank

Combine findings from all subagents:

1. **Dedupe** by `(file, approximate-line-range, type)` — if two subagents flagged overlapping issues, keep the better-written one and merge details.
2. **Rank** by severity then effort: `major-revision` before `small-fix`; within each tier, lower effort first (cheap big wins float to the top). Within `major-revision`, hot-spot files outrank non-hot-spot files for the same severity.
3. **Assign IDs** sequentially (`F-001`, `F-002`, …) in the ranked order.
4. **Tally** counts by severity and by type for the summary header.

Don't pad the report — if there are only 4 real findings, ship 4. Quality over quantity.

### Phase 6 — Write the file

Render the full report using `references/findings-template.md`. Save to:

```
docs/code-review/<YYYY>-<MM>-<DD>T<HH>-<MM>.md
```

(use UTC, with `:` replaced by `-` so the filename is portable to Windows). Create `docs/code-review/` if it doesn't exist.

The report must include, in order:
1. Header (date, branch, mode, file count, finding counts)
2. Project index (a tighter version of the architecture reference)
3. Hot-spots reviewed this run (which ones were in scope)
4. Findings (ranked, full template per finding)
5. Architecture-drift notes (if any from Phase 2)
6. Suggested next steps (a 3-5 bullet "what to do this week" digest)

### Phase 7 — Terminal summary

Print to chat (no file I/O), in this exact shape:

```
Code review — <branch> (<mode>)
Files reviewed: N · Findings: N (major: N, small: N) · Hot-spots in scope: N

Top issues:
  1. [major-revision] <title>  →  <where>
  2. [small-fix]      <title>  →  <where>
  ...

Full report: docs/code-review/<file>.md
Suggested next step: <one line>
```

Use ASCII only in the terminal block. Keep the whole block to ~25 lines or fewer. Don't restate the entire report — that's what the file is for.

## Subagent brief

When dispatching a review subagent, use a prompt structured like this:

```
You are reviewing a slice of the Mindcraft Minecraft-bot repo.

Files in your scope:
  - src/agent/agent.js
  - src/agent/history.js
  - ...

Hot-spots within your slice (review with extra care):
  - src/agent/agent.js handleMessage and the re-prompt loop
  - src/agent/history.js memory truncation
  - ...

Project context (so you can judge what's actually a problem here):
  <paste the relevant excerpts from references/mindcraft-architecture.md>

For each issue you find, return a JSON object with these exact keys:
  title, severity (small-fix|major-revision), effort (<30min|1-4h|1-2d|>1wk),
  type (bug-risk|correctness|design|perf|cost|readability|security|architecture-drift),
  where, symptom, why, fix, verify.

Wrap the array in a ```json fence and write nothing outside it except a one-line summary.

Be specific. Cite real line numbers. Do not invent issues to pad the count — if the
slice is clean, return [] and say so.
```

## Calibrating severity and effort

Reviewers (you and your subagents) tend to over-flag. Calibrate against this:

- **`major-revision`** is for things that change behavior, change a public surface, or rework a system: refactoring `Prompter.replaceStrings` to support a new placeholder type, splitting `History.memory` into multiple stores, replacing a truncation strategy. If a senior dev would put it on a multi-week roadmap, it's a major revision.
- **`small-fix`** is for changes that don't ripple: a missing null check, an off-by-one, a hardcoded magic number that should come from settings, a misleading log message, a dead branch.
- Effort estimates are wall-clock for one engineer who knows this codebase: `<30min` (config tweak / one-line patch), `1-4h` (focused change with tests), `1-2d` (a small feature, multiple files, a test suite), `>1wk` (design + multi-file refactor + migration plan).

A rough sanity check: a typical full-repo review of mindcraft should produce on the order of 8–25 findings. If you're proposing 60, you're double-counting. If you're proposing 2, you're being too generous.

## Common false positives — don't flag these

- The 500-char memory truncation in `History` IS a known design constraint, not a bug. (You CAN flag the design itself as a `major-revision` if it's clearly hurting the bot, but don't flag it as a `small-fix`.)
- Hardcoded model prefixes in `_model_map.js` are intentional — that's how provider auto-detection works.
- The 300ms tick in `agent.js` is documented behavior, not a perf bug.
- `bot.modes` and `bot.output` mutating across modules is the framework pattern; flag specific abuses, not the pattern.

## When the repo is in a weird state

- If `git` isn't available, drop into full mode and note it.
- If `docs/code-review/` can't be created (permissions, etc.), surface that as the first thing in the terminal summary and write the report to `tools/explorer/data/code-review-<timestamp>.md` as a fallback. Never silently drop the file output.
- If a subagent times out or returns malformed JSON, retry once with a sharper brief; if it fails again, note it in the report under "Coverage gaps" and proceed.
