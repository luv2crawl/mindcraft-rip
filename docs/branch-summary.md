# Branch Summary

This branch improves the bot's command selection, mining workflow, chest handling,
recovery behavior, and typed situational memory. The main goals are to make
requests like "mine iron ore" select the right commands, make repeated travel and
storage workflows memory-backed, avoid false success reports, and produce
readable diagnostics when something goes wrong.

## Example Selection

- Reworked example retrieval to rank examples from the latest user intent instead of the whole conversation history.
- Added intent normalization that strips speaker prefixes, greetings, bot names, and request filler while preserving action terms such as `mine`, `iron`, `ore`, `craft`, and `pickaxe`.
- Split example indexing text from assistant command output:
  - Primary matching uses the user's request intent.
  - Assistant command text contributes only a secondary ranking boost.
- Made example selection stable and failure-safe:
  - `getRelevant()` no longer mutates the stored example order.
  - Query embedding failures fall back to word-overlap scoring.
  - Missing example embeddings fall back instead of producing invalid scores.
  - Logs now include selected intent and assistant output.
- Improved fallback word-overlap scoring with stopword removal, token deduping, player/bot-name filtering, and Minecraft/action keyword boosts.
- Added mining/toolchain examples to the default profile, including `!planMiningRun`, `!mineOre`, `!prepareMiningRun`, `!depositAll`, and `!craftToolchainFor`.
- Added JourneyMap, route, and storage examples so natural-language requests can select `!syncJourneyMap`, `!importJourneyMapLocation`, `!goToWaypoint`, `!startRouteRecording`, `!followRoute`, `!labelNearestStorage`, `!findInStorage`, and `!restockFromStorage`.

## Situational Memory

- Replaced the old flat `MemoryBank` map with typed world memory.
- Old saved memory still migrates safely:
  - old `{ "base": [10, 64, -20] }` loads as `places.base`.
  - `rememberPlace()` and `recallPlace()` remain compatible with existing command logic.
- Added generic typed memory methods:
  - `remember(type, key, value)`
  - `recall(type, key)`
  - `list(type)`
  - `search(type, query)`
- Persisted typed memory through `History.save/load` in `bots/{bot}/memory.json`.
- Added a dirty flag so direct user commands that mutate structured memory can force a save before returning.
- Added namespaces for `places`, `journeymap.waypoints`, `routes`, `storage`, `observations`, and `pending`.
- Durable world memory now requires a high- or medium-confidence world identity.
  Low-confidence protocol/server fallbacks remain session-local until
  `settings.world_id` or another stronger identity source is configured.
- World-memory merge now preserves existing timestamp-less records on key
  collisions instead of allowing stale in-memory data to silently overwrite them.
- Added focused docs in `docs/situational-memory.md`.

## JourneyMap Integration

- Added optional JourneyMap bridge helpers and commands:
  - `!syncJourneyMap`
  - `!importJourneyMapLocation`
  - `!journeyMapWaypoints`
  - `!goToWaypoint`
  - `!exportWaypoint`
- Added parser support for pasted JourneyMap location strings with reordered fields, such as `[z:-20, name:base, x:10, dim:0, y:64]`.
- Missing `x` or `z` is rejected with structured failure output.
- Bridge failures return `journeymap_bridge_unavailable` and recommend the pasted-location fallback.
- Added an optional localhost bridge scaffold under `services/journeymap-bridge/`.

## Route Memory

- Added route recording and following commands:
  - `!startRouteRecording`
  - `!stopRouteRecording`
  - `!followRoute`
  - `!routeStatus`
  - `!continueRoute`
- Routes store ordered breadcrumbs, start/end records, dimension, timestamps, linked waypoint metadata, and last failure.
- Route following uses non-destructive pathfinding by default.
- Blocked routes save `pending.route_issue` and stop before digging.
- `!continueRoute(name, "allow_dig_once")` only permits digging for the current blocked segment and then expires.
- Route failure output uses structured reasons such as `route_blocked`, `interrupted`, and `dimension_mismatch`.

## Runtime Coordination And Transcripts

- Serialized `Agent.handleMessage()` per agent so overlapping chat/system/self
  prompts do not run concurrent model/command loops against shared history and
  action state.
- The pre-prompt history save is awaited, so pending summarization work is
  flushed before prompt construction.
- Fire-and-forget message paths now route through a queued helper that catches
  and logs failures.
- Transcript logging keeps display names separate from sanitized directory
  names, preventing profile names from escaping `bots/`.
- Transcript flush failures keep queued records for a later retry instead of
  dropping them.
- Corrupt task ledger files are backed up to `.corrupt-<timestamp>` before a
  fresh ledger is written.

## Event-Triggered Vision

- Added `!observeHere(reason)` to capture one screenshot summary when vision is enabled.
- Route failures capture one observation only when `allow_vision` is enabled.
- Normal route following does not take periodic screenshots.

## Mining Workflow

- Added/extended mining commands and objective flow:
  - `!planMiningRun`
  - `!prepareMiningRun`
  - `!mineOre`
  - `!setHomeChest`
  - `!craftToolchainFor`
  - `!depositMiningLoot`
  - `!clearObjectives`
- Added an objective stack for long-running tasks so mining can report plan, supply prep, descent, branch mining, deposit, completion, and failure states.
- Added structured objective results with `ok`, `reason`, `need`, `have`, `missing`, recommended commands, and result data.
- Updated mining runs to return structured results instead of a plain boolean.
- Fixed a critical false-success case: a run that mines `0/30` ore after hitting max steps is now reported as a partial failure, not `OK: done`.
- Stopped branch mining at the wrong Y level when staircase descent fails. The bot now fails fast with `descent_failed` instead of mining around the base/water level and pretending it completed the request.
- Mining output now includes useful scalar result data such as mined count, target count, and exit reason.

## Chest And Storage Handling

- Unified storage detection for `chest`, `trapped_chest`, and `barrel`.
- Made chest lookup consistent across storage commands, mining home-chest lookup, and `!searchForBlock("chest", ...)`.
- Remembered the last storage block successfully found/opened so `!setHomeChest` and mining can fall back to it if a later block scan misses the nearby chest.
- Fixed the case where `!takeFromChest` could open a chest, but `!setHomeChest` immediately afterwards said no chest existed nearby.
- Reworked `!viewChest` output to aggregate item totals by item type instead of logging every stack. Full chests now produce complete, compact summaries that avoid truncating the middle of the inventory.
- Added memory-backed storage logistics commands:
  - `!labelNearestStorage`
  - `!indexStorage`
  - `!indexStorageArea`
  - `!findInStorage`
  - `!restockFromStorage`
- Storage indexes are stale-cache records and report the last index time.
- `!restockFromStorage` withdraws available partial amounts, reports shortfall, and refreshes that container's index.
- `!organizeStorage` remains intentionally deferred; this branch does not move items between containers.

Example new chest output:

```text
The chest contains 54 stacks across 27 item types:
- raw_copper: 166 (3 stacks)
- amethyst_block: 128 (2 stacks)
- lapis_lazuli: 114 (2 stacks)
- raw_iron: 7 (1 stack)
```

## Recovery And Water Behavior

- Reduced false `unstuck` triggers near the base:
  - Unstuck now applies only to movement/digging actions where recovery makes sense.
  - It requires stronger evidence that the bot is actually stationary.
  - It has a cooldown to avoid repeatedly interrupting `mineOre`.
  - It no longer kills the agent after an unstuck attempt times out.
- Improved water escape behavior:
  - Detects water at both feet and head.
  - Looks for nearby dry, standable positions and navigates laterally to them.
  - Falls back to moving away instead of just jumping straight up and down.

## Command Response Handling

- Replaced first-command truncation in `Agent.handleMessage()` with explicit command-span extraction.
- Model responses that contain multiple commands now queue and execute valid commands serially in source order.
- The full assistant response is preserved in history so emitted plans and trailing commands are observable.
- Invalid or hallucinated commands add an `ERR_COMMAND_MISSING` system result and the queue continues to any later extracted command.
- Command returns are normalized and rendered with stable prefixes such as `OK`, `ERR_BAD_ARGS`, `ERR_COMMAND_MISSING`, `ERR_NO_PATH`, `ERR_INTERRUPTED`, and `ERR_PARTIAL`.
- Transcript command results are capped to avoid unbounded logs, and
  prompt-facing command output is capped before it is added back to history.
- Direct command parsing now requires the whole string to be a command, while
  model responses still use command-span extraction for commands embedded in
  prose.
- Optional trailing command parameters now use documented defaults; for example
  `!getCraftingPlan("torch")` defaults quantity to `1`.
- Updated conversation prompts and command docs to tell the model to use at most one command per response and wait for command results before issuing the next command.

## Planning And Response Caps

- Added a DEPS-style `promptNewActionPlan` step before `!newAction` code generation.
- The planner selects an immediate sub-goal and injects that plan as binding context for `promptCoding`.
- `!newAction` loads execution templates synchronously and always restores the
  `unstuck` mode to its prior pause state.
- Generated custom code rejects loop syntax (`for`, `while`, and `do/while`)
  before staging. This is a reliability guard against synchronous hangs, not a
  full security sandbox.
- Added `resolveMaxResponses()` so normal user messages stay capped to one response, while self/system prompts with active objective frames can use configured `max_commands`.

## Tooling And Tests

- Added focused tests for example normalization, fallback selection, embedding failures, selection stability, and logging.
- Added tests for storage lookup, last-known chest fallback, mining planning helpers, objective result formatting, and aggregated chest content formatting.
- Added tests for memory migration and persistence, JourneyMap location parsing, route issue records, breadcrumb thresholds, and storage index search.
- Added tests for command extraction and multi-command `Agent.handleMessage()` responses.
- Added regressions for message serialization, command-output caps, optional
  command defaults, transcript path safety, transcript retry behavior, task
  ledger corrupt-file backups, mode isolation, and generated-code loop
  rejection.
- Current verification after these changes:

```text
npm test
215 tests passed
```

## Operational Notes

- Existing running bot processes must be restarted to pick up code changes.
- A currently running mining action started before these changes may still report old-style results until the process reloads.
- The latest observed live mining run did eventually collect raw iron, but earlier failed attempts exposed the need for the partial-result and descent-failure fixes described above.
