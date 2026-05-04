from cheapest/highest impact to more structural.

  1. Make Commands More Intent-Level
  Right now many commands are primitive: collectBlocks, goToCoordinates, craftRecipe. The LLM has to compose them correctly. That is
  brittle.

  Better pattern:

  !mineOre("diamond", 10)
  !prepareMiningRun("diamond")
  !depositAll("sand")
  !recoverDroppedItems()
  !craftToolchainFor("iron_pickaxe")
  !gatherForRecipe("stone_pickaxe", 1)

  The more a command maps to a user intent, the less reasoning the model has to do. The command implementation can handle inventory
  checks, chest use, travel, retries, and failure messages.

  2. Add Preflight Checks To High-Risk Commands
  For actions that can waste minutes, validate before movement:

  - Mining: required pickaxe tier, spare tools, torches, food, chest location.
  - Construction: required blocks, blueprint location, inventory/chest supplies.
  - Crafting: recipe materials, crafting table, furnace/fuel if smelting is involved.
  - Long travel: destination reachable enough, avoid water/lava/unsafe terrain if possible.

  This is the main fix for the diamond mining problem: don’t let the bot walk 200 blocks and then discover it lacks iron picks.

  3. Make Command Failures Machine-Useful
  A lot of command outputs are conversational, but the model needs precise next steps.

  Bad:

  Not enough cobblestone to craft 1.

  Better:

  Cannot craft stone_pickaxe. Missing: cobblestone x1. Have: cobblestone x2, stick x14. Next recommended command: !
  collectBlocks("cobblestone", 1)

  This makes the next model turn much more likely to recover correctly.

  4. Add Planner Commands Instead Of Relying On Freeform LLM Planning
  For example:

  !planMiningRun("diamond", 10)

  returns:

  Need: 3 iron_pickaxe, 32 torch, crafting_table, food.
  Have: 1 iron_pickaxe, 3 stone_pickaxe, 12 stick.
  Missing: 2 iron_pickaxe or 6 iron_ingot.
  Recommended: stock home_chest or run !takeFromChest("iron_pickaxe", 2)

  Then either the LLM chooses next command, or !prepareMiningRun performs the plan.

  5. Add Domain-Specific State Machines
  For long workflows, don’t let the LLM drive every step. Use deterministic state machines:

  Mining example:

  - PREPARE_SUPPLIES
  - SELECT_SITE
  - TRAVEL_TO_SITE
  - DESCEND
  - BRANCH_MINE
  - DEPOSIT
  - RESUME
  - DONE/FAILED

  The LLM can initiate and respond to failures, but the loop itself should be code.

  6. Make Background Modes Less Destructive
  Transcript showed background modes causing bad behavior:

  - self_defense fought cod because isHostile() is too broad.
  - item_collecting triggered pathing and then unstuck escalated to clean kill.

  Fixes:

  - Restrict hostile mobs to an explicit hostile list.
  - Make item_collecting only run when truly idle and on reachable land.
  - Add cooldown/blacklist for unreachable dropped items.
  - Don’t let unstuck kill the process after background-mode failures.

  7. Improve Prompt Docs, But Treat Them As Secondary
  Command descriptions matter, but they should be short, directive, and opinionated.

  Example:

  description: 'Use this before any mining trip that requires travel. Checks home_chest and inventory for correct pickaxes, spare
  tools, torches, and crafting table. If this fails, ask the user to stock supplies instead of walking away.'

  That helps, but implementation still needs to enforce it.

  8. Add Better Command Selection Examples
  Few-shot examples are likely underused here. Add examples for common failure-prone flows:

  - “Mine diamonds” -> !setHomeChest -> !prepareMiningRun("diamond") -> travel -> !mineOre("diamond", n)
  - “Put all sand in chest” -> !inventory -> !goToRememberedPlace("home_chest") or !searchForBlock("chest", 48) -> !
    putInChest("sand", -1) if supported.
  - “Pick up items in water” -> check entities/items -> avoid boat hallucination.

  9. Prefer Structured Results Internally
  Instead of only logging strings, commands could return structured status:

  {
    ok: false,
    reason: "missing_supplies",
    missing: { iron_pickaxe: 2, torch: 32 },
    recommendedCommands: [...]
  }

  Then stringify for chat, but keep structured data for future planning or retry logic.

  10. Add Regression Evals From Real Transcripts
  The transcripts are gold. Turn failures into tests/scenarios:

  - Diamond mining without iron picks should fail before travel.
  - Passive cod should not trigger self-defense.
  - Sand collection interrupted twice should not lead to clean kill.
  - collectBlocks("stone") for stone pickaxe should understand it needs cobblestone, or the crafting helper should bridge that.

  Highest-impact next steps, in order:

  1. Fix hostile detection so cod/squid/etc. do not trigger combat.
  2. Harden item_collecting and unstuck interaction.
  3. Add more intent-level commands: depositAll, recoverDroppedItems, craftToolchainFor.
  4. Make command failure outputs include missing items and recommended next command.
  5. Add transcript-derived regression tests for these exact failures.