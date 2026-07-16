# Mindcraft Hot-Spots

These are the code paths that deserve extra reviewer attention — either because they have a history of bugs, are critical to core behavior, or are cost / performance-sensitive. When any of these is in the review scope, the reviewer should read the surrounding code with skepticism rather than just skimming.

Each entry lists:
- **Where** it lives
- **Why** it's a hot-spot
- **What to look for** during review

Use this as a checklist, not a constraint. A hot-spot can be perfectly correct on a given day. Conversely, a "cold" file can still hide a real bug — these are just the most common failure surfaces.

---

## Reasoning loop & response handling

### `Agent.handleMessage` and the re-prompt loop

- **Where:** `src/agent/agent.js`, the main `for` loop guarded by `max_responses`.
- **Why:** This is the heart of the bot. Every behavior change shows up here. It interleaves history mutation, prompt construction, model call, command parse + execute, and interrupt checks across three distinct interrupt-injection points. Subtle ordering bugs or missed interrupts cause the bot to talk to itself, drop user messages, or loop forever.
- **What to look for:**
  - Off-by-one in the loop bound vs. the interrupt checks.
  - Paths where a command result is added to history but the loop continues without re-prompting (orphan turns).
  - Paths where the loop returns without writing the assistant turn (lost responses).
  - Race conditions with `self_prompter` state flips during `await promptConvo`.
  - The `truncCommandMessage` path silently dropping content the model emitted on purpose.

### Empty-response / staleness handling

- **Where:** `Agent.handleMessage` empty-response branch + `Prompter.promptConvo` staleness drop.
- **Why:** Empty responses are the only signal the bot has that "the loop is over" — both real-empty and stale-empty look the same.
- **What to look for:** A retry storm from misclassifying transient API errors as empty responses; a stale drop that orphans a partial command-execution side effect; missing transcript event on stale drop.

### Self-prompting interrupt logic

- **Where:** `src/agent/self_prompter.js`, `shouldInterrupt`, `startLoop`, `update`.
- **Why:** It's been the source of "bot froze" and "bot wouldn't shut up" complaints. The MAX_NO_COMMAND counter is global state shared with the main loop.
- **What to look for:** State transitions that don't reset the counter; interrupts that don't propagate during an in-flight `promptConvo`; load/save of self-prompt state that leaves the loop running across a restart.

---

## Prompt construction

### `Prompter.replaceStrings` and placeholder substitution

- **Where:** `src/models/prompter.js`.
- **Why:** Every behavior change in the prompt template lands here. Adding/removing a placeholder is a typical source of silent regressions because nothing yells when a placeholder remains unfilled in the rendered prompt.
- **What to look for:**
  - Placeholders rendered as empty strings when the data is missing (waste of tokens, also confusing for the model).
  - Re-running expensive sub-commands on every prompt build (`!stats`, `!entities`, `!nearbyBlocks`) instead of caching within one `handleMessage` iteration.
  - Newly-added placeholders not actually referenced in the active profile templates.

### Examples retrieval

- **Where:** `src/utils/examples.js`, `src/utils/text.js`.
- **Why:** The example pulled determines the command style the model uses next. A subtle scoring bug means the bot picks "social greeting" examples when the user asked it to mine.
- **What to look for:**
  - Mutation of stored example order (was a bug, may regress).
  - Embedding failures silently producing zero-scores instead of falling back.
  - Stopword / player-name filtering letting in noise tokens that dominate scoring.
  - Cache misses on retry attempts (re-embedding on every retry inside one promptConvo).

### `_model_map.js` provider auto-detection

- **Where:** `src/models/_model_map.js`.
- **Why:** A new provider whose prefix collides with an existing one will silently route to the wrong adapter.
- **What to look for:** Order-sensitivity in prefix matching; unguarded `require` of an adapter that's not installed; backwards-compat shims that swallow a typo.

---

## Memory and persistence

### `History` summarization and truncation

- **Where:** `src/agent/history.js` `summarizeMemories`, `add`, `save`.
- **Why:** The 500-char hard cap on `History.memory` is the single biggest constraint on long-horizon coherence. The summarization queue + timeout has had failure-safe issues in the past.
- **What to look for:**
  - Truncation that chops mid-token / mid-sentence.
  - Summary task failures that block normal operation (should fall through, keep prior memory).
  - Race between an evicted-chunk summary and a new evict happening before the previous summary finishes.
  - `appendFullHistory` writes that don't survive a process crash.

### `MemoryBank`

- **Where:** `src/agent/memory_bank.js`.
- **Why:** Unbounded growth. Survives across sessions. Not currently pruned.
- **What to look for:** Names that overwrite each other due to case-insensitive collisions; positions persisted but never invalidated when the world changes.

### `History` persistence to disk

- **Where:** `History.save`/`load`, `bots/{name}/memory.json`.
- **Why:** A bad write here leaves the bot unable to start. The save runs after every `add` — high write churn.
- **What to look for:** Partial writes (write-then-rename pattern absent); JSON shape that breaks the loader on the next boot; growth of the file with no rotation.

---

## Tool / command output

### `ActionManager.getBotOutputSummary`

- **Where:** `src/agent/action_manager.js`.
- **Why:** Truncates command output that becomes the next system turn. Currently chops the **middle**, which deletes the most informative final lines (the actual error). Affects every multi-step action.
- **What to look for:** Off-by-one in the truncation; behavior when the output is shorter than the cap; how the cap is chosen relative to the model context window.

### Per-command output strings

- **Where:** `src/agent/commands/actions.js`, `src/agent/commands/queries.js`.
- **Why:** No central cap on output size. Each command self-limits. A misbehaving command can blow context.
- **What to look for:** A query that lists a full chest / a long entity scan without aggregation; success messages indistinguishable from "noop"; failure messages that don't include a recognizable error code.

### Command argument validation

- **Where:** `src/agent/commands/index.js` `parseCommandMessage`.
- **Why:** Strict enough to reject good commands, loose enough to accept bad ones if a new command isn't documented properly.
- **What to look for:** Type coercion that silently mangles a string into 0; domain checks that match on substring instead of exact set; a new command added to `commandList` without entries in `getCommandDocs`.

---

## Objectives & long-running actions

### `ObjectiveStack` and `mining_objective.js`

- **Where:** `src/agent/objectives/`.
- **Why:** Multi-step goals with structured results. The mining flow is the canonical case; bugs here manifest as "bot says it mined but inventory says no" (false success).
- **What to look for:**
  - `ok: true` paths that don't actually verify the goal was reached.
  - States that pop the wrong frame on early exit.
  - Result objects that lose their `reason` / `missing` fields on partial completion.

### `ActionManager` timeouts and unstuck behavior

- **Where:** `src/agent/action_manager.js`.
- **Why:** Unstuck heuristics have caused both false interrupts and missed real stuck states.
- **What to look for:** Cooldown that resets too aggressively; unstuck applied to actions that don't benefit (e.g. waiting for chests); timeouts that kill the agent process instead of just the action.

---

## Cost & latency-sensitive paths

### Calls that go to `chat_model` but don't need to

- **Where:** `Prompter.promptMemSaving`, `Prompter.promptShouldRespondToBot`, any new "housekeeping" prompt.
- **Why:** Routing a 50-token classify call to a $15/1M-token model is pure waste. There's no `cheap_model` slot today.
- **What to look for:** Any new prompt method added to `Prompter` that uses `this.chat_model` for a task that's clearly not the main reasoning step.

### Embedding model fallbacks

- **Where:** `Prompter` constructor embedding-model resolution.
- **Why:** When no embedding model is specified, falls back to whatever the chat-model API offers — for several providers this either fails or returns degraded vectors. Retrieval quality silently varies by provider.
- **What to look for:** Silent fallback paths; profiles missing an embedding-model entry; a new provider added without an explicit embedding answer.

### Per-prompt fan-out of sub-commands

- **Where:** `Prompter.replaceStrings` $STATS / $INVENTORY rendering.
- **Why:** Three command calls per prompt build, no caching. In a self-prompt loop this multiplies.
- **What to look for:** Repeated rebuilds of identical state in adjacent loop iterations.

---

## Multi-bot / concurrency

### `convoManager` and inter-bot routing

- **Where:** `src/agent/conversation.js`, `src/agent/connection_handler.js`, `src/agent/mindserver_proxy.js`.
- **Why:** Race conditions and lost messages when multiple bots are conversing. The "chat only when no other agents present" rule lives here.
- **What to look for:** Filters that hide the originating bot's name from the receiving bot; ordering of `serverProxy.getNumOtherAgents()` checks vs. message dispatch; deadlocks waiting for a peer reply.

---

## SES / sandboxing

### `library/lockdown.js` and `coder.js` execution

- **Where:** `src/agent/library/lockdown.js`, `src/agent/coder.js`.
- **Why:** `!newAction` runs model-generated code under SES lockdown. A regression that loosens the sandbox (or breaks it entirely so generated code can't run) is a serious correctness/security issue.
- **What to look for:** New globals exposed to the realm; lockdown initialized after the first `!newAction` (race); error handling that swallows a sandbox violation.

---

## Settings & wiring

### `settings.js`

- **Where:** repo root.
- **Why:** Touched by everything. Renaming a key without updating callers silently degrades behavior.
- **What to look for:** Settings read from `process.env` and from `settings.js` for the same value; defaults that don't match what the docs/profile examples say; settings used in only one file (probably should be local).

### Profile templates (`profiles/*.json`)

- **Where:** `profiles/`.
- **Why:** A typo in a placeholder name (e.g. `$MEMOR` instead of `$MEMORY`) makes the substitution silently noop. The model sees the literal string.
- **What to look for:** Placeholders in profile templates that aren't in the `replaceStrings` list; placeholders in `replaceStrings` that no profile uses.
