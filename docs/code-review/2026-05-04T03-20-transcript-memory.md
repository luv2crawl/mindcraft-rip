# Mindcraft Transcript and Memory Review

Date: 2026-05-04T03:20Z
Branch: improvements
Scope: newest GPT transcript and persisted memory files

Artifacts reviewed:

- `bots/gpt/transcripts/2026-05-04T02-37-30-429Z_13760.jsonl`
- `bots/gpt/memory.json`
- `bots/gpt/logs/conversation_2026-05-04T03-16-01-906Z.txt`
- `bots/gpt/logs/memSaving_2026-05-04T03-02-16-367Z.txt`
- `bots/_worlds/protocol_minecraft_overworld_overworld_default_forge_1.21.11_127.0.0.1_55916/memory.json`

## Summary

The latest run shows GPT 5.4 responding quickly and using commands, but the bot is ineffective because runtime context is degraded before the model sees it, and because the new memory layer tracks places/storage but not unfinished user intent.

The user asked for "copper and coal". The bot mined only copper twice. The final `bots/gpt/memory.json` still contains the original "copper and coal" request, but no durable memory field, no pending coal task, and no structured task queue. The prompt's session memory reduces the active target to `target=copper`, so "keep mining" naturally repeats copper.

## Findings

### F-001 - GPT prompt formatting duplicates recent context

Severity: major-revision
Effort: 1-4h
Type: correctness
Where: `src/models/gpt.js:24-66`, `src/utils/text.js:85`

Symptom: `GPT.sendRequest` calls `strictFormat(turns)` before the provider branch, mutates message content by appending the stop sequence, then calls `strictFormat` again in the Responses branch. `strictFormat` mutates message objects while converting `system` messages to `user` messages and merging consecutive user turns. The conversation logs show the effect: system results are combined with the next user message, and the next user message appears duplicated with `***` markers.

Evidence: `bots/gpt/logs/conversation_2026-05-04T03-16-01-906Z.txt:312-352` shows `go mine some copper and coal` and later `how are you doing?` duplicated inside prior `SYSTEM:` entries. `src/models/gpt.js:25`, `src/models/gpt.js:58`, and `src/models/gpt.js:60` are the double-format/append path.

Why it matters: Switching to GPT will not help if GPT receives malformed role/content ordering. The model is being asked to reason over repeated, delimiter-polluted context, making it more likely to repeat the last command or ignore part of the user's original request.

Fix: Make `strictFormat` pure or pass it cloned messages. In `GPT.sendRequest`, remove the unused pre-branch formatting and avoid appending `***` to each chat message for the Responses API. Use provider-native stop handling where supported; for GPT-5 Responses, trim the model output after the fact only.

Verify: Add a GPT adapter unit test that passes `[system result, user follow-up]` through `sendRequest` with a mocked client and asserts the OpenAI input contains each user message exactly once and contains no synthetic `***` suffix in message content.

### F-002 - Multi-resource intent is reduced to a single scalar target

Severity: major-revision
Effort: 1-2d
Type: design
Where: `src/agent/session_memory.js:1-84`, `src/models/prompter.js:149-163`

Symptom: Session memory has one `currentResourceTarget`. Command metadata overwrites it with the first command argument, so the request "go mine some copper and coal" becomes `target=copper`. The final prompt summary says `Current session: last_command=!mineOre; target=copper; last_result=OK`.

Evidence: transcript lines `59-66` show the inbound user request and the model choosing `!mineOre("copper", 16)`. `bots/gpt/memory.json:6`, `:10`, `:42`, and `:46` show the persisted run remembers the original request but only two copper commands/results. `bots/gpt/logs/conversation_2026-05-04T03-16-01-906Z.txt:5-6` shows the structured prompt memory has only `target=copper`.

Why it matters: This is the direct reason "keep mining" repeated copper instead of moving to coal. Memory is currently good at surfacing world facts, but it does not preserve unresolved user goals.

Fix: Represent requested resources as a small pending-work list, for example `{ kind: "mine", targets: [{item:"copper", status:"done"}, {item:"coal", status:"pending"}] }`. Update it on command result. Prompt it as "remaining task: mine coal" instead of `target=copper`.

Verify: Add an agent/session-memory test for "mine copper and coal" followed by a successful copper result; the formatted session memory should mention coal as pending and should not present copper as the only target.

### F-003 - Durable memory did not capture user intent or inventory/storage results

Severity: small-fix
Effort: 1-4h
Type: correctness
Where: `bots/gpt/memory.json:2-58`, world memory `memory.json:42-50`

Symptom: `bots/gpt/memory.json` has `"memory": ""`; summarization ran twice and returned empty. The world memory persisted `home_chest` and `mining_entry`, but `storage.home_chest.counts` is `{}` even after a successful copper mining run whose result says `mined: 16`.

Evidence: transcript lines `97-100` and `131-134` show memory summaries ending with empty memory. `bots/gpt/memory.json:46` records "Mining objective completed for copper" while the world storage file line `50` has empty counts.

Why it matters: The new memory system preserves map anchors, but the bot still cannot answer "what did I accomplish?" or "where did the mined copper go?" from durable memory. This undercuts task continuity after long actions.

Fix: Keep routine inventory snapshots out of long-term chat memory, but update structured memory on task completion: completed resource, deposit/storage destination, and remaining task if any. If `mineOre` deposits into `home_chest`, refresh or patch the storage index.

Verify: Run a mining objective in a test harness with a fake storage memory bank and assert the saved world memory contains the deposited ore count or a recent completion observation.

### F-004 - World memory identity is low confidence and includes the local port

Severity: small-fix
Effort: <30min
Type: bug-risk
Where: `settings.js:70`, transcript `world_identity.resolve.low_confidence`

Symptom: The resolved world id is `protocol_minecraft_overworld_overworld_default_forge_1.21.11_127.0.0.1_55916` with confidence `low`. The port is part of the path.

Evidence: transcript line `5` and world memory lines `3-5`.

Why it matters: If the local server port changes, the bot will write a different world memory directory and appear to forget saved places/storage even though the memory system is working.

Fix: Set a stable `world_id` in `settings.js` for this world/server.

Verify: Restart on a different port and confirm `!worldMemoryStatus` still reports the same memory path.

### F-005 - Chat memory is disabled for this GPT run

Severity: small-fix
Effort: <30min
Type: design
Where: `settings.js:28`, transcript `agent.start`

Symptom: The GPT session started with `load_mem=false`, and `settings.js` has `"load_memory": false`. World memory loads, but profile chat memory and prior turns do not.

Evidence: transcript lines `1` and `3` show `load_mem:false`.

Why it matters: If the expectation is continuity across model switches or bot restarts, this setting makes the bot start without its bot-scoped memory file even though world-scoped memory still loads.

Fix: Turn on `load_memory` when evaluating cross-session behavior, or be explicit that only world memory is expected to persist.

Verify: Restart the GPT profile and confirm transcript startup records `load_mem:true` and a `memory.load` event.

## Suggested Next Steps

1. Fix `GPT.sendRequest` formatting first. It is the most likely model-specific regression.
2. Add a pending-intent/session-memory structure for multi-step user requests.
3. Set `settings.world_id` to a stable value for this test world.
4. Decide whether this evaluation expects bot chat memory across restarts; if yes, set `load_memory` to true.
5. Add a storage update after successful mining/deposit so world memory can explain where mined items went.
