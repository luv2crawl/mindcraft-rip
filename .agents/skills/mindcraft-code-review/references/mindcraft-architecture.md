# Mindcraft Architecture Index

This is the baked-in component map for the Mindcraft Minecraft-bot. It lets the reviewer judge what code is doing in the larger system, rather than guessing at it from individual files.

The index is intentionally short. For deep understanding, the reviewer should read the actual source — this doc is a pointer. Verify file paths against the live tree before quoting them.

## One-paragraph summary

Mindcraft wraps a Mineflayer-based Minecraft bot in a multi-LLM agent loop. A player chat message enters the `Agent`, gets added to `History`, is rendered into a prompt by the `Prompter` (template + retrieved examples + current world state), and is sent to the configured chat model. The model responds with either chat text or a `!command(...)`. Commands run via the dispatcher in `commands/index.js`, their output is appended back to `History` as a system turn, and the model is prompted again — this is the reasoning loop. A 300ms tick updates `modes` and the `SelfPrompter`. Memory has three layers: recent turns in `History.turns`, a long-term running summary in `History.memory`, and structured facts in `MemoryBank`. Everything is observed via `TranscriptLogger`.

## Component-by-component index

### Entry / lifecycle

- `main.js` — CLI entry, profile loading, spawns one or more bots via `mindcraft/mindcraft.js`.
- `settings.js` — runtime settings (max_messages, max_commands, cooldowns, spawn timeout, server config). Hot config — read everywhere.
- `src/mindcraft/mindcraft.js`, `src/mindcraft/mindserver.js`, `src/mindcraft/mcserver.js` — process orchestration and the optional mindserver coordinator.

### Agent core

- `src/agent/agent.js` — the orchestrator. Owns `start()`, `_setupEventHandlers()`, `handleMessage()`, the chat-vs-command response loop, lifecycle events (death, idle, disconnect), the 300ms `update()` tick.
- `src/agent/history.js` — `turns` (recent), `memory` (long-term running summary, hard-capped at 500 chars), persistence to `bots/{name}/memory.json`, queued summarization of evicted chunks.
- `src/agent/action_manager.js` — tracks the currently-running action and per-action timeout/output capture (`getBotOutputSummary`).
- `src/agent/self_prompter.js` — autonomous follow-up prompts. Stops after `MAX_NO_COMMAND` consecutive empty responses.
- `src/agent/modes.js` — pluggable behavior modes (collect-on-the-way, defend-self, etc.). Emits a behavior log that's flushed into the next prompt as system context.
- `src/agent/memory_bank.js` — flat key→value store of named world positions (home_chest, last_death_position, …).
- `src/agent/transcript_logger.js` — observability. Records chat, model request/response/failure, command parse/start/end/failure, memory events, lifecycle.
- `src/agent/conversation.js`, `src/agent/connection_handler.js`, `src/agent/mindserver_proxy.js` — multi-bot conversation routing and inter-process glue.
- `src/agent/speak.js` — TTS hook, optional.

### Commands and skills

- `src/agent/commands/index.js` — dispatcher, `containsCommand`, `parseCommandMessage`, `executeCommand`. Strict argument validation (name, count, type, domain).
- `src/agent/commands/actions.js` — action commands (mine, craft, equip, build, navigate, mining objectives, …). Each returns a free-text result that becomes the next system turn.
- `src/agent/commands/queries.js` — read-only commands (inventory, entities, nearby blocks, stats, view chest, …).
- `src/agent/objectives/objective_stack.js`, `objective_results.js`, `mining_objective.js` — long-running multi-step objectives with structured `{ok, reason, need, have, missing, …}` results. The mining flow is the canonical example.
- `src/agent/library/skills.js`, `skill_library.js` — library of named coding-time skills exposed to `!newAction` and the coder. Read-only at runtime.
- `src/agent/library/full_state.js`, `world.js`, `index.js` — world inspection helpers used by skills and queries.
- `src/agent/library/lockdown.js` — SES-style lockdown for `!newAction` execution.
- `src/agent/library/ore_data.js` — Minecraft ore lookup tables.
- `src/agent/coder.js` — owns `!newAction` code generation, sandboxing, and result capture.
- `src/agent/npc/` — older NPC controller (item_goal, build_goal). Largely independent of the modern agent loop.
- `src/agent/tasks/` — Mindcraft task scaffolding (construction, cooking) used for benchmarks and challenges.

### Prompter and models

- `src/models/prompter.js` — `promptConvo` (chat), `promptCoding` (code), `promptMemSaving` (summary), `promptVision` (vision), `promptShouldRespondToBot`. Owns `replaceStrings` (placeholder substitution: $NAME, $STATS, $INVENTORY, $ACTION, $COMMAND_DOCS, $EXAMPLES, $MEMORY, $CONVO, $SELF_PROMPT, $LAST_GOALS, $BLUEPRINTS), retry/cooldown/staleness guardrails, the `</think>` and `(FROM OTHER BOT)` cleanup.
- `src/models/_model_map.js` — auto-loads every adapter in this directory and infers the API from the model-name prefix. Provider auto-detection is by string prefix.
- `src/models/{gpt,claude,gemini,groq,cerebras,qwen,deepseek,mistral,ollama,openrouter,grok,replicate,huggingface,glhf,hyperbolic,lmstudio,novita,mercury,azure}.js` — provider adapters. Each implements `sendRequest(turns, systemMessage)` and (where supported) `sendVisionRequest(...)`. Uniform interface.
- `src/utils/examples.js` — embedding-based example retrieval with a word-overlap fallback. Uses `latestIntentText()` to focus on the most recent user request. Stable ordering, failure-safe.
- `src/utils/text.js` — text normalization helpers (intent normalization, stopword stripping, fallback relevance scoring).
- `src/utils/keys.js` — API-key loading from `keys.json`.

### Vision

- `src/agent/vision/vision_interpreter.js` — adapter that hands screenshots to `promptVision`.
- `src/agent/vision/camera.js`, `browser_viewer.js` — frame capture via prismarine-viewer.

### Tools (developer-only, not part of the runtime bot)

- `tools/explorer/` — the local dashboard for understanding the bot (this skill's sibling). Not loaded at runtime.

### Tests

- `test/` — `node --test` suites covering examples retrieval, mining planning, chest aggregation, objective results, history, etc.

## Profiles, prompts, persisted state

- `profiles/` — per-bot JSON profiles. Each profile pins `chat_model`, `code_model`, `vision_model`, `embedding`, the `conversing` template (with placeholders), the `coding` template, `saving_memory`, examples list, etc. Most "behavior changes" should land in a profile, not in code.
- `andy.json` — tiny example profile.
- `keys.json` — API keys.
- `bots/{name}/` — per-bot persisted state: `memory.json` (history + memory + self-prompt state), `histories/` (archived removed history chunks), captured screenshots, optional skill artifacts.

## Important runtime invariants worth knowing while reviewing

- A response containing a command is **truncated to the first command** — anything after is dropped silently.
- `History.memory` is **hard-capped at 500 characters** with a "compress more next time" suffix on the prompt.
- `settings.max_commands` caps the re-prompt loop per inbound message; `settings.max_messages` triggers history-chunk eviction.
- Stale model responses are dropped: if a newer user message arrived while the model was thinking, the response never reaches the user.
- Commands return a string. That string becomes the next `system` turn in `History`. Output quality directly steers the model's next decision.
- The 300ms update loop runs `modes` then `self_prompter`, and is the entry point for autonomous behavior between user messages.
