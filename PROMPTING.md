# Prompting Mindcraft Bots

A practical guide to talking to a Mindcraft bot effectively. Setup and install live in [README.md](README.md); this document is about *how to get the bot to do what you want once it's running.*

## Quick start

| You say | What the bot does |
|---|---|
| `Come here` | `!goToPlayer("yourname", 3)` |
| `Follow me` | `!followPlayer("yourname", 4)` |
| `Stop` | `!stop` |
| `Collect 10 oak logs` | `!collectBlocks("oak_log", 10)` |
| `Remember this spot as base` | `!rememberHere("base")` |
| `Go to base` | `!goToRememberedPlace("base")` |
| `Save this chest as the home chest` (stand next to it) | `!setHomeChest` |
| `Get ready to mine diamonds before we walk over there` | `!prepareMiningRun("diamond")` |
| `Mine 32 iron` (with `home_chest` set) | `!mineOre("iron", 32)` |
| `Build a 5x5 cobblestone hut here` | `!newAction("Build a 5x5 cobblestone hut at my position")` |
| `Survive on your own forever` | `!goal("Survive forever: gather food, build shelter, sleep at night...")` then `!endGoal` to stop |

If a command works the first time, the same phrasing will keep working — see [Phrasing patterns](#phrasing-patterns) for why.

## How the bot understands you

Each time you send a message, the bot rebuilds its context from scratch:

1. The system prompt is template-rendered with **fresh** `$STATS` (position, health, hunger, time, biome, weather, nearby players), `$INVENTORY`, `$NEARBY_BLOCKS`, `$COMMAND_DOCS` (the full command catalog), `$EXAMPLES` (top-K few-shot examples retrieved by similarity to your message), and `$MEMORY` (a running 500-char summary).
2. The model writes a free-form reply that may contain a command in the form `!commandName("arg1", 1.5)`.
3. The harness extracts command spans, **type-checks the arguments**, runs valid commands serially, and feeds each output back in as a `system` message.
4. The prompt tells the model to use at most one command per response. If it emits more than one anyway, the runtime no longer silently drops the later commands; it queues them in source order and stops the queue on the first invalid, interrupted, failed, or empty-result command.
5. The bot can chain commands across model turns: after command output is added to history, it may prompt the model again, up to `max_commands` times per message (set in `settings.js`, currently `-1` for unlimited).
6. Independently, every 300 ms a "modes" loop reacts to the world (running from lava, fighting back, picking up items, etc.); whatever it does is appended to a behavior log that the bot sees on your *next* message.

Implications worth knowing:

- **The bot has no persistent world model.** Its only "memory" is the 500-char summary, the chat history, and the named places saved via `!rememberHere`. Everything else is recomputed each turn.
- **Type checks are strict.** `!collectBlocks("oak_log", "ten")` fails because `num` is `int`. So does `!goToCoordinates(0, 500, 0, 1)` because Y must be in `[-64, 320]`. The bot sees the validation error and usually corrects on the next attempt.
- **Command output drives chained reasoning.** When the bot runs `!searchForBlock("oak_log", 64)` and the system replies "Could not find any oak_log in 64 blocks," the bot will often follow up with `!searchForBlock("oak_log", 128)`. The command-result loop is what makes multi-step tasks work without manual re-prompting.
- **Modes can interrupt.** `self_preservation`, `self_defense`, `cowardice`, and `unstuck` interrupt **any** action. `hunting`, `item_collecting`, `torch_placing`, and `elbow_room` only interrupt `!followPlayer` (and the new chunked navigation in `!goToRememberedPlace`/`!mineOre`, which suspends the distracting ones for the duration).

## Phrasing patterns

### Match the few-shot examples

The conversation examples in `profiles/defaults/_default.json` (and any per-profile additions) are retrieved by embedding similarity to your message. The closest match floats to the top of the model's prompt. So phrasing your request like an existing example reliably triggers the same command.

| Closer to an example (works) | Drifts from examples (gambles) |
|---|---|
| `come here` | `swing by my location` |
| `collect 10 oak logs` | `harvest some timber` |
| `build a dirt tower` | `construct a tall pillar of soil` |
| `kill that zombie` | `eliminate the undead` |

If you find phrasing that works well, write it down and consider adding it as a new entry in `conversation_examples` so it becomes a fixed point for the future.

### Imperative + specific noun

Vague openers tend to produce chat instead of commands.

| Produces a command | Produces chat |
|---|---|
| `look at the chest` | `take a peek over there` |
| `what blocks are nearby?` | `notice anything around?` |
| `stand near my base` | `meet me where you usually are` |

### Name your places explicitly

`!rememberHere("base")` saves the position as `base` in the memory bank. From then on:

- Saying `go to base` works because the example shows that pattern.
- Saying `home_chest` (the convention `!mineOre` uses) works only if you've actually saved a place named `home_chest`.
- Saying `go to where I usually craft` does not work — the bot will say "no location named that saved" and you've lost a turn.

Convention-style names that the new mining workflow understands:

- `home_chest` — deposit destination for `!mineOre`.
- `mining_entry` — automatically saved by `!mineOre` when it starts; bot returns here between deposit cycles.

### When using `!newAction`, be specific

`!newAction(prompt)` triggers the coding loop, which writes JavaScript against the skills/world API and runs it. The quality of the code scales directly with the specificity of your prompt.

| Specific (good) | Vague (rolls the dice) |
|---|---|
| `Build a 7x7x4 oak plank house with a door on the south wall and a window on the east wall, centered at my position` | `Make a house` |
| `Place dirt blocks in a 3-block-wide line heading north for 20 blocks` | `Make a path` |
| `Dig a 2-tall corridor 30 blocks east, placing torches every 6 blocks` | `Mine eastward` |

The model can see `world.getPosition(bot)`, `skills.placeBlock(...)`, etc. — the better you describe the target, the better its code.

## Command reference

Generated from `actionsList` and `queryList` (see `src/agent/commands/`). Categorized for skimming.

### Movement & navigation

| Command | What it does |
|---|---|
| `!goToPlayer(name, closeness)` | Walk to a player. `closeness` is "stop within N blocks." |
| `!followPlayer(name, follow_dist)` | Endlessly follow until stopped. Pauses distracting modes when far. |
| `!goToCoordinates(x, y, z, closeness)` | Walk to coords. Y clamped to `[-64, 320]`. |
| `!searchForBlock(type, range)` | Find and walk to nearest matching block. Range ≥ 32. |
| `!searchForEntity(type, range)` | Find and walk to nearest matching entity. |
| `!moveAway(distance)` | Leave current location in any direction. |
| `!stay(seconds)` | Freeze in place; suspends most modes. `-1` for indefinite. |

### Memory & places

| Command | What it does |
|---|---|
| `!rememberHere(name)` | Save current `(x, y, z)` under `name`. |
| `!goToRememberedPlace(name)` | Walk to a saved place. Uses chunked nav for long trips. |
| `!setHomeChest` | Save the position of the nearest chest within 16 blocks as `home_chest`. |

### Inventory & containers

| Command | What it does |
|---|---|
| `!inventory` | Print current inventory and worn armor. |
| `!equip(item_name)` | Equip an item to the appropriate slot (hand or armor). |
| `!discard(item_name, num)` | Drop items. Walks away briefly so they don't clutter your feet. |
| `!consume(item_name)` | Eat or drink. |
| `!putInChest(item_name, num)` | Deposit into the nearest chest within 32 blocks. |
| `!depositAll(item_name)` | Deposit every stack of one item into the nearest chest. |
| `!depositMiningLoot(ore_name)` | Deposit ore drops and common mining spoil while keeping tools/supplies. |
| `!takeFromChest(item_name, num)` | Withdraw from the nearest chest. |
| `!viewChest` | Print contents of the nearest chest. |
| `!recoverDroppedItems` | Pick up nearby dropped items after mining, crafting, or chest overflow. |
| `!givePlayer(player, item, num)` | Drop items at a player's feet. |

### Gathering & mining

| Command | What it does |
|---|---|
| `!collectBlocks(type, num)` | Greedy nearest-block collection (no pattern, no torches). Useful for surface stuff like wood, dirt, stone. |
| `!gatherForRecipe(item, num)` | Print missing recipe supplies, then gather simple nearby block-source ingredients when possible. |
| `!prepareMiningRun(ore_name)` | Before walking to a mining site, check/pull/craft needed mining supplies from inventory or `home_chest`. Use this first when a mining request may require travel. |
| `!mineOre(ore_name, num)` | Branch-mine for a specific ore at its best Y. Prepares supplies, validates pickaxe tier, places torches every 6 blocks, returns to `home_chest` when full, resumes. **Requires `home_chest` to be set first.** |
| `!digDown(distance)` | Dig straight down with safety checks (stops at lava/water/long fall). Use sparingly. |
| `!goToSurface` | Walk straight up to the highest non-air block at current X/Z. |

Known ore names for `!mineOre` (case- and form-insensitive — `iron`, `Iron`, `iron_ore` all work):
`coal`, `copper`, `iron`, `lapis_lazuli`, `gold`, `redstone`, `diamond`, `emerald`, `nether_quartz`, `nether_gold`, `ancient_debris`.

### Crafting & smelting

| Command | What it does |
|---|---|
| `!craftable` | List recipes you currently have materials for. |
| `!craftToolchainFor(tool)` | Craft `wooden_pickaxe`, `stone_pickaxe`, `iron_pickaxe`, or `diamond_pickaxe` from current inventory/nearby crafting context; fails fast if materials are missing. |
| `!craftRecipe(item, num)` | Craft a recipe `num` times (not `num` items — read the description). |
| `!smeltItem(item, num)` | Smelt items in the nearest furnace. |
| `!clearFurnace` | Take everything out of the nearest furnace. |
| `!placeHere(block)` | Place one block at the bot's feet. |

### Combat & sleep

| Command | What it does |
|---|---|
| `!attack(entity_type)` | Attack the nearest entity of that type. |
| `!attackPlayer(name)` | Attack a player. |
| `!goToBed` | Find the nearest bed and sleep. |

### Self-driven goals

| Command | What it does |
|---|---|
| `!goal(prompt)` | Start endlessly self-prompting toward `prompt`. The bot generates its own messages on a loop. |
| `!endGoal` | Stop self-prompting. |
| `!setMode(mode_name, on)` | Toggle a mode on/off (e.g., `!setMode("hunting", false)`). |
| `!modes` | Print all modes and their current state. |

### Looking & vision

If `allow_vision: true` in `settings.js`, the bot can describe what it sees:

| Command | What it does |
|---|---|
| `!lookAtPlayer(name, "at" \| "with")` | Look at a player; with `"with"`, also analyze the screenshot. |
| `!lookAtPosition(x, y, z)` | Look at a coordinate; analyzes the screenshot. |

### Information

| Command | What it does |
|---|---|
| `!stats` | Position, health, hunger, biome, time, weather, nearby players. |
| `!nearbyBlocks` | List of distinct block types within range. |
| `!entities` | Nearby living entities. |

### Coding escape hatch

| Command | What it does |
|---|---|
| `!newAction(prompt)` | Generate and execute JavaScript that uses `bot`, `skills`, `world`. The quality scales with prompt specificity. Disabled unless `allow_insecure_coding: true`. |

### Meta / control

| Command | What it does |
|---|---|
| `!stop` | Cancel the current action. |
| `!stfu` | Mute chat and stop self-prompting; current action keeps running. |
| `!clearChat` | Wipe chat history. |
| `!restart` | Restart the agent process. |

## Common workflows

### Mine a stack of iron

```
(stand next to a chest)
!setHomeChest
!prepareMiningRun("iron")
(walk over to where you want to start the mine)
!mineOre("iron", 64)
```

Before traveling, the bot checks `home_chest`/inventory for enough pickaxes, a crafting table, and basic supplies. If supplies are missing, it should stop and report what the user needs to stock instead of walking to the mining site unprepared.

The bot will: validate it has at least a stone pickaxe → save `mining_entry` at the start position → descend to Y≈16 (the closer of iron's two best-Y values to the surface) → branch-mine south, scanning walls/floor/ceiling for iron ore at every step → place a torch every 6 steps → when ≤2 inventory slots are free, walk back to `home_chest`, deposit raw iron and spoil blocks (cobblestone, deepslate, dirt, etc.), and return to `mining_entry` to resume → stop when 64 raw iron is on hand.

If you want the corridor to head a different direction, you'd extend `!mineOre` to take a direction param (currently hard-coded to south). Until then, face the bot in the desired direction by walking that way before starting.

### Save and travel between named places

```
(at your base)
!rememberHere("base")

(at a chest you frequently use)
!setHomeChest

(at a far-off mining outpost ~600 blocks away)
!rememberHere("mine_north")

(later)
!goToRememberedPlace("mine_north")
```

The chunked-navigation logic (`goToPositionChunked` in `src/agent/library/skills.js`) breaks the trip into ~80-block segments, suspends `item_collecting`/`hunting`/`torch_placing` for the duration, and reports progress.

### Run an autonomous goal until complete

```
!goal("Get to a stone pickaxe: gather 5 oak logs, craft a crafting table and wooden pickaxe, mine 6 cobblestone, craft a stone pickaxe.")
```

The bot will self-prompt every couple seconds, taking actions and observing results, until you `!endGoal` or it decides it's done. If the goal is too vague ("survive forever"), it'll wander; if it's too specific ("place block at exact coords"), regular commands work better.

### Suspend a mode for one task

```
!setMode("hunting", false)
!followPlayer("yourname", 4)
```

Re-enable when done:

```
!setMode("hunting", true)
```

## Pitfalls

- **Forgetting `home_chest` before `!mineOre`.** The bot will fall back to "nearest chest within 32 blocks at start time" and tell you in chat. To avoid surprise, set `home_chest` explicitly.
- **Asking the bot to roleplay in asterisks.** The system prompt explicitly forbids `*stops*` style — the bot will translate to a command (`!stop`) and may sound terse. Write what you want done, not how you'd describe doing it.
- **Naming things ambiguously.** `!rememberHere("here")` followed days later by "go to here" is a recipe for confusion. Use distinctive names.
- **Expecting the bot to remember conversational context across runs.** The 500-char `$MEMORY` is a *summary*; if you need a fact preserved, save it as a place or restate it.
- **`!digDown` is technically allowed.** It exists for emergencies and is not what you want for mining — `!mineOre` does proper 2-tall corridors with torches.
- **`!collectBlocks` doesn't place torches.** It uses a greedy nearest-block scan with no pattern. Fine for surface trees and stone, bad for ores at depth (use `!mineOre`).
- **Big distances in coordinate-style commands can fail silently in single-pathfind mode.** `!goToCoordinates(...)` doesn't currently route through chunked nav (only `!goToRememberedPlace` does); if you have a far destination, save it first and use `!goToRememberedPlace`.
- **Prefer one command at a time.** The runtime can recover if the model emits multiple commands in one response, but the prompt contract is still one command per response so each next step can use the previous command's output. For long-running multi-step plans, use `!goal(...)`.
- **`only_chat_with` is exclusive.** If `settings.js` has `only_chat_with: ["mbarc"]`, the bot ignores everyone else. Useful when streaming or running a public server, but easy to forget.
- **`!newAction` is disabled by default.** Set `allow_insecure_coding: true` in `settings.js` to enable. The bot can write and run arbitrary JS in the bot process — only enable on trusted machines.

## Teaching the bot a new phrasing

If you keep finding yourself saying something the bot doesn't quite parse, the cleanest fix is to add it to the few-shot examples — that way the *next* time you say it, the example is retrieved and sets the precedent.

Edit `profiles/defaults/_default.json` (or your bot's profile JSON) and append to `conversation_examples`:

```json
[
  { "role": "user",      "content": "yourname: take stock of the chest" },
  { "role": "assistant", "content": "Let me check. !viewChest" }
]
```

Restart the bot. The new example becomes part of the retrieval pool. Over time, you can build a dialect specific to your play style.

## Related files

- `src/agent/commands/actions.js` — the actions catalog.
- `src/agent/commands/queries.js` — read-only queries.
- `src/agent/library/skills.js` — the underlying mineflayer skill implementations.
- `src/agent/library/ore_data.js` and `minecraft_ores.json` — ore tiers, best-Y, pickaxe requirements consumed by `!mineOre`.
- `src/agent/modes.js` — the reactive modes.
- `profiles/defaults/_default.json` — the system prompt and few-shot examples that shape the bot's behavior.
