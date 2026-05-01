# Branch Summary

This branch improves the bot's command selection, mining workflow, chest handling, and recovery behavior. The main goal is to make mining requests like "mine iron ore" reliably select mining commands, prepare the right supplies, avoid false success reports, and produce readable diagnostics when something goes wrong.

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
- Fixed a critical false-success case: a run that mines `0/30` ore after hitting max steps is now reported as `FAILED: partial`, not `OK: done`.
- Stopped branch mining at the wrong Y level when staircase descent fails. The bot now fails fast with `descent_failed` instead of mining around the base/water level and pretending it completed the request.
- Mining output now includes useful scalar result data such as mined count, target count, and exit reason.

## Chest And Storage Handling

- Unified storage detection for `chest`, `trapped_chest`, and `barrel`.
- Made chest lookup consistent across storage commands, mining home-chest lookup, and `!searchForBlock("chest", ...)`.
- Remembered the last storage block successfully found/opened so `!setHomeChest` and mining can fall back to it if a later block scan misses the nearby chest.
- Fixed the case where `!takeFromChest` could open a chest, but `!setHomeChest` immediately afterwards said no chest existed nearby.
- Reworked `!viewChest` output to aggregate item totals by item type instead of logging every stack. Full chests now produce complete, compact summaries that avoid truncating the middle of the inventory.

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

## Tooling And Tests

- Added focused tests for example normalization, fallback selection, embedding failures, selection stability, and logging.
- Added tests for storage lookup, last-known chest fallback, mining planning helpers, objective result formatting, and aggregated chest content formatting.
- Current verification after these changes:

```text
npm test
81 tests passed
```

## Operational Notes

- Existing running bot processes must be restarted to pick up code changes.
- A currently running mining action started before these changes may still report old-style results until the process reloads.
- The latest observed live mining run did eventually collect raw iron, but earlier failed attempts exposed the need for the partial-result and descent-failure fixes described above.
