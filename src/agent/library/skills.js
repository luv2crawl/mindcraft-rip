import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../settings.js";
import {
    getOreInfo,
    getOreBlockNames,
    getBestY,
    botHasRequiredPickaxe,
    getKnownOres,
} from './ore_data.js';
import { objectiveResult, formatObjectiveResult } from '../objectives/objective_results.js';

function getBlockPlaceDelay() {
    return settings.block_place_delay == null ? 0 : settings.block_place_delay;
}

async function waitForBlockPlaceDelay() {
    const blockPlaceDelay = getBlockPlaceDelay();
    if (blockPlaceDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, blockPlaceDelay));
    }
}

export function log(bot, message) {
    bot.output += message + '\n';
}

function rememberLastStorageBlock(bot, block) {
    if (block?.position) {
        bot.mindcraftLastChestPosition = {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
            name: block.name,
        };
    }
    return block;
}

export function getLastKnownStoragePosition(bot, maxDistance = null) {
    const remembered = bot?.mindcraftLastChestPosition;
    if (!remembered) return null;
    const pos = new Vec3(remembered.x, remembered.y, remembered.z);
    if (maxDistance !== null && bot.entity?.position?.distanceTo(pos) > maxDistance)
        return null;

    const block = bot.blockAt ? bot.blockAt(pos) : null;
    if (block && !world.isStorageBlock(block))
        return null;

    return {
        x: remembered.x,
        y: remembered.y,
        z: remembered.z,
        source: 'last_known',
    };
}

export function getNearestStoragePosition(bot, maxDistance = 16) {
    const block = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, maxDistance));
    if (block?.position) {
        return {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
            source: 'nearby',
        };
    }
    return getLastKnownStoragePosition(bot, maxDistance);
}

function _positionRecordFromMemory(key, record, source) {
    if (!record) return null;
    const pos = Array.isArray(record)
        ? { x: record[0], y: record[1], z: record[2] }
        : record;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return {
        name: pos.name || key,
        x,
        y,
        z,
        dimension: pos.dimension ?? pos.dim ?? null,
        source,
    };
}

function _getNamedMemoryPosition(memoryBank, type, key, source) {
    if (!memoryBank?.recall) return null;
    return _positionRecordFromMemory(key, memoryBank.recall(type, key), source);
}

function _getNamedMemoryPositionCaseInsensitive(memoryBank, type, key, source) {
    const exact = _getNamedMemoryPosition(memoryBank, type, key, source);
    if (exact) return exact;
    if (!memoryBank?.list) return null;
    const wanted = String(key || '').toLowerCase();
    const records = memoryBank.list(type) || {};
    for (const [recordKey, record] of Object.entries(records)) {
        if (String(recordKey).toLowerCase() === wanted || String(record?.name || '').toLowerCase() === wanted) {
            return _positionRecordFromMemory(recordKey, record, source);
        }
    }
    return null;
}

function _isDesignatedBaseName(name) {
    return String(name || '').toLowerCase().includes('base');
}

export function getClosestDesignatedBasePosition(bot, memoryBank = null) {
    if (!memoryBank?.list) return null;
    const currentDimension = bot?.game?.dimension ?? null;
    const candidates = [];
    for (const [key, record] of Object.entries(memoryBank.list('places') || {})) {
        const candidate = _positionRecordFromMemory(key, record, 'base:places');
        if (candidate && _isDesignatedBaseName(candidate.name)) candidates.push(candidate);
    }
    for (const [key, record] of Object.entries(memoryBank.list('journeymap.waypoints') || {})) {
        const candidate = _positionRecordFromMemory(key, record, 'base:journeymap');
        if (candidate && _isDesignatedBaseName(candidate.name)) candidates.push(candidate);
    }
    for (const [key, record] of Object.entries(memoryBank.list('storage') || {})) {
        const candidate = _positionRecordFromMemory(key, record, 'base:storage');
        if (candidate && _isDesignatedBaseName(candidate.name)) candidates.push(candidate);
    }
    const sameDimension = candidates.filter(candidate =>
        !candidate.dimension || !currentDimension || candidate.dimension === currentDimension
    );
    const usable = sameDimension.length > 0 ? sameDimension : candidates;
    if (usable.length === 0) return null;
    usable.sort((a, b) => {
        const botPos = bot?.entity?.position;
        if (!botPos?.distanceTo) return a.name.localeCompare(b.name);
        return botPos.distanceTo(new Vec3(a.x, a.y, a.z)) - botPos.distanceTo(new Vec3(b.x, b.y, b.z));
    });
    return usable[0];
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function withSuspendedModes(bot, modeNames, fn) {
    /**
     * Pause the listed modes for the duration of fn, then unpause on completion or error.
     * Modes that are not registered are silently skipped so callers can pass a uniform list.
     * @param {MinecraftBot} bot
     * @param {string[]} modeNames - mode names to pause (e.g. ['item_collecting', 'hunting'])
     * @param {() => Promise<any>} fn - async function to run while modes are suspended
     */
    const paused = [];
    for (const name of modeNames) {
        try {
            if (bot.modes.exists(name)) {
                bot.modes.pause(name);
                paused.push(name);
            }
        } catch (e) { /* mode registry not ready or mode missing — ignore */ }
    }
    try {
        return await fn();
    } finally {
        for (const name of paused) {
            try { bot.modes.unpause(name); } catch (e) { /* swallow */ }
        }
    }
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'unknown_recipe',
            message: `Cannot craft ${itemName}: not an item or no recipe exists.`,
            data: { item: itemName },
        })));
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null);
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'missing_crafting_table',
                    message: `Cannot craft ${itemName}: needs a crafting table within ${craftingTableRange} blocks and none in inventory.`,
                    have: world.getInventoryCounts(bot),
                    missing: { crafting_table: 1 },
                    recommendedCommands: ['!craftRecipe("crafting_table", 1)'],
                })));
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        const inventory = world.getInventoryCounts(bot);
        const recipeOptions = mc.getItemCraftingRecipes(itemName) || [];
        // Pick the recipe whose missing-cost is smallest given current inventory.
        let best = null;
        for (const option of recipeOptions) {
            const required = option[0] || {};
            const missing = {};
            for (const [ing, count] of Object.entries(required)) {
                const have = inventory[ing] || 0;
                if (have < count) missing[ing] = count - have;
            }
            const totalMissing = Object.values(missing).reduce((a, b) => a + b, 0);
            if (!best || totalMissing < best.totalMissing) best = { required, missing, totalMissing };
        }
        const required = best?.required || {};
        const missing = best?.missing || {};
        const recommendedCommands = Object.entries(missing).map(([ing, count]) => `!collectBlocks("${ing}", ${count})`);
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'missing_ingredients',
            message: `Cannot craft ${itemName}: missing ingredients.`,
            need: required,
            have: _filterPositiveCounts(Object.fromEntries(Object.keys(required).map(k => [k, inventory[k] || 0]))),
            missing,
            recommendedCommands,
        })));
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftLimit.num<num) {
        const post = world.getInventoryCounts(bot);
        const shortfall = num - craftLimit.num;
        const perCraft = requiredIngredients[craftLimit.limitingResource] || 1;
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'partial_craft',
            message: `Crafted ${craftLimit.num} of ${itemName} (wanted ${num}); ran out of ${craftLimit.limitingResource}.`,
            need: { [craftLimit.limitingResource]: perCraft * num },
            have: _filterPositiveCounts({ [craftLimit.limitingResource]: post[craftLimit.limitingResource] || 0, [itemName]: post[itemName] || 0 }),
            missing: { [craftLimit.limitingResource]: perCraft * shortfall },
            recommendedCommands: [`!collectBlocks("${craftLimit.limitingResource}", ${perCraft * shortfall})`],
            data: { crafted: craftLimit.num, target: num },
        })));
    }
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...');
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item);
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot);

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...');
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...');
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0) {
                log(bot, formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'no_blocks_nearby',
                    message: `No ${blockType} within 64 blocks of current position.`,
                    missing: { [blockType]: num },
                    recommendedCommands: [`!searchForBlock("${blockType}", 128)`],
                    data: { searched_radius: 64, types_tried: blocktypes.join(', ') },
                })));
            }
            else {
                log(bot, `Collected ${collected}/${num} ${blockType}; no more within 64 blocks.`);
            }
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'missing_bucket',
                    message: `Cannot harvest ${blockType}: bucket required.`,
                    have: world.getInventoryCounts(bot),
                    missing: { bucket: 1 },
                    recommendedCommands: ['!craftRecipe("bucket", 1)'],
                })));
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) {
            const haveTools = Object.fromEntries(Object.entries(world.getInventoryCounts(bot)).filter(([k]) => k.endsWith('_pickaxe') || k.endsWith('_axe') || k.endsWith('_shovel') || k.endsWith('_hoe') || k === 'shears'));
            log(bot, formatObjectiveResult(objectiveResult({
                ok: false,
                reason: 'wrong_tool',
                message: `Cannot harvest ${block.name}: held item lacks required tool tier.`,
                have: haveTools,
                data: { block: block.name, equipped: bot.heldItem ? bot.heldItem.name : 'nothing' },
            })));
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            await waitForBlockPlaceDelay();
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        await waitForBlockPlaceDelay();
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            await waitForBlockPlaceDelay();
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            await waitForBlockPlaceDelay();
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    };
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, 32));
    if (!chest) {
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'no_chest_in_range',
            message: `Cannot put ${itemName}: no chest within 32 blocks.`,
            missing: { chest_within_32_blocks: 1 },
            recommendedCommands: ['!searchForBlock("chest", 64)'],
        })));
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        const have = world.getInventoryCounts(bot);
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'item_not_in_inventory',
            message: `Cannot put ${itemName}: none in inventory.`,
            have,
            missing: { [itemName]: num === -1 ? 1 : num },
            recommendedCommands: [`!collectBlocks("${itemName}", ${num === -1 ? 1 : num})`],
        })));
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    try {
        await chestContainer.deposit(item.type, null, to_put);
    } catch (err) {
        await chestContainer.close();
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'deposit_threw',
            message: `Could not deposit ${to_put} ${itemName}: ${err.message}.`,
            have: world.getInventoryCounts(bot),
            data: { error: err.message },
        })));
        return false;
    }
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

async function _depositNamedItemsInNearestChest(bot, itemNames) {
    const names = new Set([...itemNames].filter(Boolean));
    if (names.size === 0) return false;
    let chest = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, 32));
    if (!chest) {
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'no_chest_in_range',
            message: `Cannot deposit: no chest within 32 blocks.`,
            missing: { chest_within_32_blocks: 1 },
            recommendedCommands: ['!searchForBlock("chest", 64)'],
            data: { wanted: [...names].join(', ') },
        })));
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    const depositedByName = {};
    const failedByName = {};
    try {
        // Snapshot stacks once before depositing. Re-running findInventoryItem after
        // a deposit can return stale entries (mineflayer hasn't refreshed yet) and
        // cause chestContainer.deposit to throw "Can't find <item> in slots [27 - 63]".
        const stacks = bot.inventory.items().filter(i => i && names.has(i.name));
        for (const item of stacks) {
            try {
                await chestContainer.deposit(item.type, null, item.count);
                depositedByName[item.name] = (depositedByName[item.name] || 0) + item.count;
            } catch (err) {
                failedByName[item.name] = (failedByName[item.name] || 0) + item.count;
                log(bot, `Could not deposit ${item.count} ${item.name}: ${err.message}.`);
            }
        }
    } finally {
        await chestContainer.close();
    }
    const totalDeposited = Object.values(depositedByName).reduce((a, b) => a + b, 0);
    if (totalDeposited === 0) {
        log(bot, formatObjectiveResult(objectiveResult({
            ok: false,
            reason: Object.keys(failedByName).length > 0 ? 'all_deposits_threw' : 'nothing_to_deposit',
            message: Object.keys(failedByName).length > 0
                ? `Tried to deposit but every stack failed.`
                : `No matching items in inventory to deposit.`,
            have: world.getInventoryCounts(bot),
            data: {
                looked_for: [...names].join(', '),
                failed: Object.entries(failedByName).map(([n, c]) => `${n} x${c}`).join(', ') || 'none',
            },
        })));
        return false;
    }
    if (Object.keys(failedByName).length > 0) {
        log(bot, formatObjectiveResult(objectiveResult({
            ok: true,
            reason: 'partial_deposit',
            message: `Deposited ${totalDeposited} items, but some stacks failed.`,
            data: {
                deposited: Object.entries(depositedByName).map(([n, c]) => `${n} x${c}`).join(', '),
                failed: Object.entries(failedByName).map(([n, c]) => `${n} x${c}`).join(', '),
            },
        })));
        return true;
    }
    log(bot, `Deposited ${totalDeposited} items into the chest (${Object.entries(depositedByName).map(([n, c]) => `${n} x${c}`).join(', ')}).`);
    return true;
}

export async function depositAll(bot, itemName) {
    /**
     * Deposit every stack of the named item into the nearest chest.
     * This is a safer command target than putInChest(..., -1), which chat params cannot express.
     */
    return await _depositNamedItemsInNearestChest(bot, [itemName]);
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, 32));
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export function formatChestContents(items) {
    if (!items || items.length === 0)
        return 'The chest is empty.';

    const totals = new Map();
    for (const item of items) {
        if (!item?.name) continue;
        const current = totals.get(item.name) || { count: 0, stacks: 0 };
        current.count += item.count || 0;
        current.stacks++;
        totals.set(item.name, current);
    }

    if (totals.size === 0)
        return 'The chest is empty.';

    const lines = [`The chest contains ${items.length} stacks across ${totals.size} item types:`];
    const sorted = [...totals.entries()].sort(([nameA, a], [nameB, b]) => {
        if (b.count !== a.count) return b.count - a.count;
        return nameA.localeCompare(nameB);
    });
    for (const [name, { count, stacks }] of sorted) {
        const stackText = stacks === 1 ? '1 stack' : `${stacks} stacks`;
        lines.push(`- ${name}: ${count} (${stackText})`);
    }
    return lines.join('\n');
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, 32));
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    log(bot, formatChestContents(items));
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export function _goalApproxDistance(bot, goal) {
    // Best-effort read of a goal's target XYZ. GoalNear/GoalBlock expose .x/.y/.z directly.
    // For other goal types (GoalFollow, GoalInvert, etc.) we don't try to introspect — return null
    // and the caller will use the max timeout, which is the safe choice.
    if (goal == null) return null;
    if (typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
        return bot.entity.position.distanceTo(new Vec3(goal.x, goal.y, goal.z));
    }
    return null;
}

export function _computePathfindTimeout(bot, goal) {
    const base = settings.pathfind_timeout_base_ms ?? 1000;
    const perBlock = settings.pathfind_timeout_per_block_ms ?? 30;
    const max = settings.pathfind_timeout_max_ms ?? 15000;
    const dist = _goalApproxDistance(bot, goal);
    if (dist == null) return max;
    return Math.max(base, Math.min(max, base + perBlock * dist));
}

export async function goToGoal(bot, goal, options = {}) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {Object} [options]
     * @param {boolean} [options.forceDestructive=false] - skip non-destructive plan attempt.
     * @param {boolean} [options.nonDestructiveOnly=false] - never choose a digging path.
     * @param {boolean} [options.failOnNoPath=false] - if both plan attempts fail, return false
     *   instead of falling through to "attempt anyway." Used by chunked nav so it can react.
     * @returns {Promise<boolean>} true if pathfinder.goto resolved (reached the goal), false on
     *   plan failure with failOnNoPath, or throws on goto error.
     **/

    const nonDestructiveMovements = new pf.Movements(bot);
    nonDestructiveMovements.canDig = false;
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);

    let final_movements = null;

    const pathfind_timeout = _computePathfindTimeout(bot, goal);
    if (!options.forceDestructive) {
        const ndPath = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout);
        if (ndPath.status === 'success') {
            final_movements = nonDestructiveMovements;
            log(bot, `Found non-destructive path.`);
        }
    }
    if (final_movements == null && !options.nonDestructiveOnly) {
        const dPath = await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout);
        if (dPath.status === 'success') {
            final_movements = destructiveMovements;
            log(bot, `Found destructive path.`);
        }
    }
    if (final_movements == null) {
        if (options.failOnNoPath) {
            log(bot, `Path not found within ${pathfind_timeout}ms.`);
            return false;
        }
        if (options.nonDestructiveOnly) {
            log(bot, `Non-destructive path not found within ${pathfind_timeout}ms.`);
            return false;
        }
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
        final_movements = destructiveMovements;
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    const agent = bot.mindcraft_agent;
    const goalMode = goal?.constructor?.name ?? null;
    const target_pos =
        typeof goal?.x === 'number' ? { x: goal.x, y: goal.y, z: goal.z } : null;
    const dist_initial = _goalApproxDistance(bot, goal);
    agent?.transcript?.record('pathfinder.start', {
        target_pos,
        mode: goalMode,
        dist_initial,
    }, 'skills', { stage: 'pathfinder' });

    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ];
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToPositionNonDestructive(bot, x, y, z, min_distance=2) {
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    try {
        const goal = new pf.goals.GoalNear(x, y, z, min_distance);
        const ok = await goToGoal(bot, goal, { nonDestructiveOnly: true, failOnNoPath: true });
        if (!ok) return false;
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance + 1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
        return false;
    } catch (err) {
        log(bot, `Non-destructive pathfinding stopped: ${err.message}.`);
        return false;
    }
}

export async function goToPositionAllowDigOnce(bot, x, y, z, min_distance=2) {
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance), { forceDestructive: true });
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance + 1) {
            log(bot, `Reached approved digging segment at ${x}, ${y}, ${z}.`);
            return true;
        }
        log(bot, `Approved digging segment did not reach ${x}, ${y}, ${z}; ${Math.round(distance)} blocks away.`);
        return false;
    } catch (err) {
        log(bot, `Approved digging segment failed: ${err.message}.`);
        return false;
    }
}

export async function goToPositionChunked(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position, breaking long journeys into chunks so the pathfinder
     * never has to plan more than ~nav_chunk_distance blocks at once. Pauses item_collecting,
     * hunting, and torch_placing for the duration so the bot doesn't get sidetracked.
     * Falls back to a direct goToPosition for short distances.
     * @param {MinecraftBot} bot
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} min_distance - closeness for the final goal. Defaults to 2.
     * @returns {Promise<boolean>}
     */
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }

    const target = new Vec3(x, y, z);
    const threshold = settings.nav_chunk_threshold ?? 100;
    const chunkDist = settings.nav_chunk_distance ?? 80;
    const retryLimit = settings.nav_chunk_retry_limit ?? 2;

    const totalDistance = bot.entity.position.distanceTo(target);
    if (totalDistance <= threshold) {
        return await goToPosition(bot, x, y, z, min_distance);
    }

    // Pure-vertical targets can't be chunked along the XZ vector — every "intermediate"
    // would land at the bot's current position. Fall through to a direct pathfind, but
    // still suspend distracting modes for the duration.
    const dxAbs = Math.abs(target.x - bot.entity.position.x);
    const dzAbs = Math.abs(target.z - bot.entity.position.z);
    if (dxAbs < 1 && dzAbs < 1) {
        log(bot, `Pure-vertical nav to Y=${Math.round(y)}; using direct pathfind.`);
        return await withSuspendedModes(bot, ['item_collecting', 'hunting', 'torch_placing'], async () => {
            return await goToPosition(bot, x, y, z, min_distance);
        });
    }

    log(bot, `Long-distance nav to (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}), ~${Math.round(totalDistance)} blocks away. Chunking.`);

    return await withSuspendedModes(bot, ['item_collecting', 'hunting', 'torch_placing'], async () => {
        const MAX_CHUNKS = 50;
        let chunksDone = 0;
        while (!bot.interrupt_code && chunksDone < MAX_CHUNKS) {
            const here = bot.entity.position;
            const remaining = here.distanceTo(target);
            if (remaining <= threshold) {
                log(bot, `Within ${threshold} blocks of target, finishing journey.`);
                return await goToPosition(bot, x, y, z, min_distance);
            }

            const wp = _interpolateChunkWaypoint(here, target, chunkDist);
            log(bot, `Chunk waypoint (${wp.x}, ${wp.y}, ${wp.z}); ${Math.round(remaining)} blocks remaining.`);

            const goal = new pf.goals.GoalNear(wp.x, wp.y, wp.z, 5);
            let success = false;
            for (let attempt = 0; attempt <= retryLimit; attempt++) {
                if (bot.interrupt_code) break;
                const isLastAttempt = attempt === retryLimit;
                const opts = {
                    forceDestructive: attempt > 0,
                    failOnNoPath: !isLastAttempt,
                };
                try {
                    const res = await goToGoal(bot, goal, opts);
                    if (res) { success = true; break; }
                    log(bot, `Chunk plan attempt ${attempt + 1}/${retryLimit + 1} found no path; retrying.`);
                } catch (err) {
                    log(bot, `Chunk attempt ${attempt + 1}/${retryLimit + 1} error: ${err.message}.`);
                }
            }
            if (!success) {
                log(bot, `Could not reach chunk waypoint after ${retryLimit + 1} attempts. Aborting journey.`);
                return false;
            }
            chunksDone++;
        }
        if (bot.interrupt_code) {
            log(bot, `Long-distance navigation interrupted.`);
            return false;
        }
        log(bot, `Long-distance navigation safety limit (${MAX_CHUNKS} chunks) reached.`);
        return false;
    });
}

export function _interpolateChunkWaypoint(here, target, chunkDist) {
    const dx = target.x - here.x;
    const dz = target.z - here.z;
    const planar = Math.sqrt(dx * dx + dz * dz);
    const scale = planar > 0 ? Math.min(chunkDist, planar) / planar : 0;
    return new Vec3(
        Math.round(here.x + dx * scale),
        Math.round(here.y + (target.y - here.y) * scale),
        Math.round(here.z + dz * scale)
    );
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else if (blockType === 'chest') {
        block = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, range));
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity;
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        await placeBlock(bot, 'farmland', x, y, z);
        await placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`);
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``;
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    };
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

// ---------------------------------------------------------------------------
// Mining: branch-mine a corridor toward a target ore, return to a designated
// chest when inventory fills, resume until the requested count is collected.
// ---------------------------------------------------------------------------

const SPOIL_BLOCKS = [
    'cobblestone', 'cobbled_deepslate', 'granite', 'diorite', 'andesite',
    'tuff', 'dirt', 'gravel', 'netherrack',
];

const ORE_DROPS = {
    coal: ['coal'],
    copper: ['raw_copper'],
    iron: ['raw_iron'],
    lapis_lazuli: ['lapis_lazuli'],
    gold: ['raw_gold'],
    redstone: ['redstone'],
    diamond: ['diamond'],
    emerald: ['emerald'],
    nether_quartz: ['quartz'],
    nether_gold: ['gold_nugget'],
    ancient_debris: ['ancient_debris'],
};

export function getMiningDropNames(oreName) {
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) return [];
    return (ORE_DROPS[oreInfo.key] || []).slice();
}

const MINING_PICKAXE_RANK = {
    wooden_pickaxe: 1,
    golden_pickaxe: 1,
    stone_pickaxe: 2,
    iron_pickaxe: 3,
    diamond_pickaxe: 4,
    netherite_pickaxe: 5,
};

const MINING_TIER_RANK = {
    wooden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
};

const MINING_PICKAXE_BY_TIER = {
    wooden: 'wooden_pickaxe',
    stone: 'stone_pickaxe',
    iron: 'iron_pickaxe',
    diamond: 'diamond_pickaxe',
    netherite: 'netherite_pickaxe',
};

const TOOLCHAIN_RECIPES = {
    wooden_pickaxe: { planks: 3, sticks: 2 },
    stone_pickaxe: { cobblestone: 3, sticks: 2 },
    iron_pickaxe: { iron_ingot: 3, sticks: 2 },
    diamond_pickaxe: { diamond: 3, sticks: 2 },
};

async function _craftPlanksFromAnyLog(bot) {
    const inventory = world.getInventoryCounts(bot);
    for (const wood of mc.WOOD_TYPES) {
        if ((inventory[`${wood}_planks`] || 0) > 0) return true;
    }
    for (const wood of mc.WOOD_TYPES) {
        if ((inventory[`${wood}_log`] || 0) > 0) {
            return await craftRecipe(bot, `${wood}_planks`, 1);
        }
    }
    return false;
}

async function _ensureToolchainSticks(bot, needed = 2) {
    let inventory = world.getInventoryCounts(bot);
    if ((inventory.stick || 0) >= needed) return true;
    const hasPlanks = mc.WOOD_TYPES.some(wood => (inventory[`${wood}_planks`] || 0) > 0);
    if (!hasPlanks) {
        const madePlanks = await _craftPlanksFromAnyLog(bot);
        if (!madePlanks) return false;
    }
    await craftRecipe(bot, 'stick', 1);
    inventory = world.getInventoryCounts(bot);
    return (inventory.stick || 0) >= needed;
}

async function _ensureCraftingTableAvailable(bot) {
    const inventory = world.getInventoryCounts(bot);
    if ((inventory.crafting_table || 0) > 0 || world.getNearestBlock(bot, 'crafting_table', 16)) {
        return true;
    }
    const hasPlanks = mc.WOOD_TYPES.some(wood => (inventory[`${wood}_planks`] || 0) >= 4);
    if (!hasPlanks) {
        const madePlanks = await _craftPlanksFromAnyLog(bot);
        if (!madePlanks) return false;
    }
    return await craftRecipe(bot, 'crafting_table', 1);
}

export async function craftToolchainFor(bot, toolName) {
    /**
     * Craft a known tool from available inventory and nearby crafting table context.
     * It intentionally does not gather raw ingredients; use it before traveling so the
     * bot fails fast when chests/inventory do not contain the required materials.
     */
    const target = (toolName || '').toLowerCase();
    if (!TOOLCHAIN_RECIPES[target]) {
        log(bot, `No toolchain recipe for ${toolName}. Supported: ${Object.keys(TOOLCHAIN_RECIPES).join(', ')}.`);
        return false;
    }
    const inventory = world.getInventoryCounts(bot);
    if ((inventory[target] || 0) > 0) {
        log(bot, `Already have ${inventory[target]} ${target}.`);
        return true;
    }
    if (!await _ensureCraftingTableAvailable(bot)) {
        log(bot, `Need a crafting_table or enough wood/planks to make one before crafting ${target}.`);
        return false;
    }
    if (TOOLCHAIN_RECIPES[target].sticks && !await _ensureToolchainSticks(bot, TOOLCHAIN_RECIPES[target].sticks)) {
        log(bot, `Need sticks or wood/planks to craft ${target}.`);
        return false;
    }
    const refreshed = world.getInventoryCounts(bot);
    for (const [itemName, count] of Object.entries(TOOLCHAIN_RECIPES[target])) {
        if (itemName === 'sticks') continue;
        if (itemName === 'planks') {
            const plankCount = mc.WOOD_TYPES.reduce((sum, wood) => sum + (refreshed[`${wood}_planks`] || 0), 0);
            if (plankCount < count) {
                log(bot, `Need ${count} planks to craft ${target}; have ${plankCount}. Stock inventory/home_chest first.`);
                return false;
            }
            continue;
        }
        if ((refreshed[itemName] || 0) < count) {
            log(bot, `Need ${count} ${itemName} to craft ${target}; have ${refreshed[itemName] || 0}. Stock inventory/home_chest first.`);
            return false;
        }
    }
    return await craftRecipe(bot, target, 1);
}

export async function depositMiningLoot(bot, oreName) {
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) {
        log(bot, `Unknown ore: ${oreName}. Known: ${getKnownOres().join(', ')}.`);
        return { ok: false, reason: 'unknown_ore', mined: 0 };
    }
    const dropList = ((ORE_DROPS[oreInfo.key] || []).concat(SPOIL_BLOCKS));
    return await _depositNamedItemsInNearestChest(bot, dropList);
}

function _missingItemsFromCraftingPlan(plan) {
    const missing = {};
    for (const line of plan.split('\n')) {
        const match = line.match(/^- (\d+) ([a-z0-9_]+)$/);
        if (match) missing[match[2]] = Number(match[1]);
    }
    return missing;
}

export async function gatherForRecipe(bot, itemName, count = 1) {
    const plan = mc.getDetailedCraftingPlan(itemName, count, world.getInventoryCounts(bot));
    log(bot, plan);
    const missing = _missingItemsFromCraftingPlan(plan);
    const gatherableBlocks = {
        cobblestone: 'cobblestone',
        stone: 'stone',
        coal: 'coal_ore',
        raw_iron: 'iron_ore',
        raw_gold: 'gold_ore',
        raw_copper: 'copper_ore',
        diamond: 'diamond_ore',
        redstone: 'redstone_ore',
        lapis_lazuli: 'lapis_ore',
    };
    for (const wood of mc.WOOD_TYPES) {
        gatherableBlocks[`${wood}_log`] = `${wood}_log`;
    }
    let gatheredAny = false;
    for (const [missingItem, missingCount] of Object.entries(missing)) {
        const blockName = gatherableBlocks[missingItem];
        if (!blockName) continue;
        const ok = await collectBlock(bot, blockName, Math.min(missingCount, 16));
        gatheredAny = gatheredAny || ok;
        if (bot.interrupt_code) break;
    }
    if (!gatheredAny && Object.keys(missing).length > 0) {
        log(bot, `No nearby gatherable block source found for missing recipe items: ${Object.keys(missing).join(', ')}.`);
    }
    return gatheredAny || Object.keys(missing).length === 0;
}

export function _countEligibleMiningPickaxes(inventory, minTier) {
    const minRank = MINING_TIER_RANK[minTier] || 1;
    let total = 0;
    for (const [itemName, count] of Object.entries(inventory || {})) {
        if ((MINING_PICKAXE_RANK[itemName] || 0) >= minRank) {
            total += count;
        }
    }
    return total;
}

function _countCraftableMiningPickaxes(inventory, targetPickaxe) {
    if (targetPickaxe === 'iron_pickaxe') {
        return Math.min(
            Math.floor((inventory.iron_ingot || 0) / 3),
            Math.floor((inventory.stick || 0) / 2),
        );
    }
    if (targetPickaxe === 'stone_pickaxe') {
        return Math.min(
            Math.floor((inventory.cobblestone || 0) / 3),
            Math.floor((inventory.stick || 0) / 2),
        );
    }
    return 0;
}

function _addCounts(target, source) {
    for (const [item, count] of Object.entries(source || {})) {
        target[item] = (target[item] || 0) + count;
    }
    return target;
}

function _subtractCounts(need, have) {
    const missing = {};
    for (const [item, count] of Object.entries(need || {})) {
        const short = count - (have[item] || 0);
        if (short > 0) missing[item] = short;
    }
    return missing;
}

function _filterPositiveCounts(counts) {
    const filtered = {};
    for (const [item, count] of Object.entries(counts || {})) {
        if (count > 0) filtered[item] = count;
    }
    return filtered;
}

function _miningNeedFor(oreInfo, oreName, currentY) {
    const targetY = getBestY(oreName, Math.floor(currentY));
    const deepMining = typeof targetY === 'number' && targetY < 0;
    const undergroundMining = typeof targetY === 'number' && targetY < 60;
    const desiredPickaxes = deepMining || MINING_TIER_RANK[oreInfo.min_pickaxe] >= MINING_TIER_RANK.iron ? 3 : 2;
    const minTier = oreInfo.min_pickaxe;
    const targetPickaxe = MINING_PICKAXE_BY_TIER[minTier] || `${minTier}_pickaxe`;
    const need = {
        [targetPickaxe]: desiredPickaxes,
    };
    if (undergroundMining && oreInfo.key !== 'coal') {
        need.torch = 32;
    }
    return { targetY, deepMining, undergroundMining, desiredPickaxes, minTier, targetPickaxe, need };
}

export function buildMiningPlanFromInventory(oreName, num, inventory, options = {}) {
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) {
        return objectiveResult({
            ok: false,
            reason: 'unknown_ore',
            message: `Unknown ore: ${oreName}. Known: ${getKnownOres().join(', ')}.`,
        });
    }
    const { targetY, desiredPickaxes, minTier, targetPickaxe, need } = _miningNeedFor(
        oreInfo,
        oreName,
        options.currentY ?? 64,
    );
    const have = { ..._filterPositiveCounts(inventory) };
    const eligiblePickaxes = _countEligibleMiningPickaxes(inventory, minTier);
    const craftablePickaxes = _countCraftableMiningPickaxes(inventory, targetPickaxe);
    have[`${minTier}_or_better_pickaxe`] = eligiblePickaxes;
    if (craftablePickaxes > 0) have[`craftable_${targetPickaxe}`] = craftablePickaxes;

    const missing = {};
    if (eligiblePickaxes < desiredPickaxes) {
        const missingPickaxes = desiredPickaxes - eligiblePickaxes;
        if (craftablePickaxes < missingPickaxes) {
            missing[targetPickaxe] = Math.max(0, missingPickaxes - craftablePickaxes);
            _addCounts(missing, _missingMiningSupplies(inventory, minTier, desiredPickaxes));
        }
    }
    if (need.torch && (inventory.torch || 0) < need.torch) {
        missing.torch = need.torch - (inventory.torch || 0);
    }

    const missingFiltered = _filterPositiveCounts(missing);
    const recommendedCommands = [];
    for (const [item, count] of Object.entries(missingFiltered)) {
        if (item.endsWith('_pickaxe') || item === 'crafting_table' || item === 'torch' || item === 'stick' || item.endsWith('_ingot')) {
            recommendedCommands.push(`!takeFromChest("${item}", ${count})`);
        }
    }
    if (Object.keys(missingFiltered).length > 0 && recommendedCommands.length === 0) {
        recommendedCommands.push(`Stock home_chest with ${Object.entries(missingFiltered).map(([item, count]) => `${count} ${item}`).join(', ')}`);
    }

    return objectiveResult({
        ok: Object.keys(missingFiltered).length === 0,
        reason: Object.keys(missingFiltered).length === 0 ? 'ready' : 'missing_supplies',
        message: Object.keys(missingFiltered).length === 0
            ? `Ready to mine ${num} ${oreInfo.display}.`
            : `Cannot mine ${oreInfo.display} yet; mining supplies are missing.`,
        need,
        have,
        missing: missingFiltered,
        recommendedCommands,
        data: {
            ore: oreInfo.key,
            display: oreInfo.display,
            targetY,
            desiredPickaxes,
            minTier,
            targetPickaxe,
        },
    });
}

export function planMiningRun(bot, oreName, num, options = {}) {
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) {
        return objectiveResult({
            ok: false,
            reason: 'unknown_ore',
            message: `Unknown ore: ${oreName}. Known: ${getKnownOres().join(', ')}.`,
        });
    }
    const chestPos = getMiningHomeChestPosition(bot, options.memoryBank || null);
    const inventory = world.getInventoryCounts(bot);
    if (!chestPos) {
        const needInfo = _miningNeedFor(oreInfo, oreName, bot.entity.position.y);
        return objectiveResult({
            ok: false,
            reason: 'missing_home_chest',
            message: `No home_chest set and no chest within 32 blocks. Save a chest before mining so supplies/deposits are deterministic.`,
            need: needInfo.need,
            have: inventory,
            missing: { home_chest: 1 },
            recommendedCommands: ['!setHomeChest'],
            data: { ore: oreInfo.key, targetY: needInfo.targetY, chestPos: null },
        });
    }
    const plan = buildMiningPlanFromInventory(oreName, num, inventory, {
        currentY: bot.entity.position.y,
    });
    plan.data.chestPos = chestPos;
    const entryPlan = selectMiningEntry(bot, oreName, chestPos, options);
    if (entryPlan.ok) {
        plan.data.miningEntry = entryPlan.entry;
        plan.data.direction = entryPlan.direction.label;
        if (entryPlan.source !== 'current') {
            plan.message += ` Use mining entry at (${entryPlan.entry.x}, ${entryPlan.entry.y}, ${entryPlan.entry.z}) heading ${entryPlan.direction.label}.`;
        }
    } else if (plan.ok) {
        return objectiveResult({
            ok: false,
            reason: 'unsafe_mining_start',
            message: `Cannot mine ${oreInfo.display} yet; no safe mining entry/descent start was found near the bot.`,
            need: plan.need,
            have: plan.have,
            missing: { safe_mining_start: 1 },
            recommendedCommands: ['Move away from the chest/base edge to solid ground, then retry !mineOre.'],
            data: {
                ...plan.data,
                miningEntry: null,
                failure: entryPlan.reason,
                failurePosition: entryPlan.failurePosition || null,
                failureBlock: entryPlan.failureBlock || null,
            },
        });
    } else {
        plan.data.miningEntryFailure = entryPlan;
    }
    if (chestPos.source === 'nearby') {
        plan.message += ` Using nearest chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}); save home_chest to make this explicit.`;
    } else if (chestPos.source?.startsWith('base:')) {
        plan.message += ` No nearby chest found; return mined items to designated base "${chestPos.name}" at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}).`;
    }
    return plan;
}

export function _missingMiningSupplies(inventory, minTier, desiredPickaxes) {
    const targetPickaxe = MINING_PICKAXE_BY_TIER[minTier] || 'stone_pickaxe';
    const eligiblePickaxes = _countEligibleMiningPickaxes(inventory, minTier);
    const craftablePickaxes = _countCraftableMiningPickaxes(inventory, targetPickaxe);
    const needsPickaxeCrafting = eligiblePickaxes < desiredPickaxes;
    const missing = {};
    const shortPickaxes = Math.max(0, desiredPickaxes - eligiblePickaxes - craftablePickaxes);
    if (shortPickaxes > 0) {
        if (targetPickaxe === 'iron_pickaxe') {
            missing.iron_ingot = shortPickaxes * 3;
            missing.stick = shortPickaxes * 2;
        } else if (targetPickaxe === 'stone_pickaxe') {
            missing.cobblestone = shortPickaxes * 3;
            missing.stick = shortPickaxes * 2;
        } else {
            missing[targetPickaxe] = shortPickaxes;
        }
    }
    if (needsPickaxeCrafting && (inventory.crafting_table || 0) < 1) missing.crafting_table = 1;
    return missing;
}

export function getMiningHomeChestPosition(bot, memoryBank = null) {
    if (memoryBank) {
        const recalled = memoryBank.recallPlace('home_chest');
        if (recalled) return { x: recalled[0], y: recalled[1], z: recalled[2], source: 'memory' };
        const explicitHomeChest =
            _getNamedMemoryPositionCaseInsensitive(memoryBank, 'storage', 'home_chest', 'storage:home_chest')
            || _getNamedMemoryPositionCaseInsensitive(memoryBank, 'journeymap.waypoints', 'home_chest', 'journeymap:home_chest');
        if (explicitHomeChest) return explicitHomeChest;
    }
    const nearby = rememberLastStorageBlock(bot, world.getNearestStorageBlock(bot, 32));
    if (!nearby) {
        return getClosestDesignatedBasePosition(bot, memoryBank) || getLastKnownStoragePosition(bot, 64);
    }
    return {
        x: nearby.position.x,
        y: nearby.position.y,
        z: nearby.position.z,
        source: 'nearby',
    };
}

async function _takeMiningSupplyFromChest(bot, itemName, count) {
    if (count <= 0) return;
    try {
        await takeFromChest(bot, itemName, count);
    } catch (e) {
        log(bot, `Could not take ${itemName} from home chest: ${e}.`);
    }
}

async function _craftMiningPickaxesIfPossible(bot, minTier, desiredPickaxes) {
    const targetPickaxe = MINING_PICKAXE_BY_TIER[minTier] || 'stone_pickaxe';
    for (let i = 0; i < desiredPickaxes; i++) {
        const inventory = world.getInventoryCounts(bot);
        if (_countEligibleMiningPickaxes(inventory, minTier) >= desiredPickaxes) break;
        if (targetPickaxe === 'iron_pickaxe') {
            if ((inventory.iron_ingot || 0) < 3 || (inventory.stick || 0) < 2) break;
        } else if (targetPickaxe === 'stone_pickaxe') {
            if ((inventory.cobblestone || 0) < 3 || (inventory.stick || 0) < 2) break;
        }
        let crafted = false;
        try {
            crafted = await craftRecipe(bot, targetPickaxe, 1);
        } catch (e) {
            log(bot, `Could not craft ${targetPickaxe} for mining supplies: ${e.message || e}.`);
            break;
        }
        if (!crafted) break;
    }
}

async function _tryCraftMiningSupply(bot, itemName, count) {
    try {
        return await craftRecipe(bot, itemName, count);
    } catch (e) {
        log(bot, `Could not craft ${itemName} for mining supplies: ${e.message || e}.`);
        return false;
    }
}

export async function prepareMiningSupplies(bot, oreName, chestPos) {
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) return false;
    const { desiredPickaxes, minTier, need } = _miningNeedFor(oreInfo, oreName, Math.floor(bot.entity.position.y));

    let inventory = world.getInventoryCounts(bot);
    if (_countEligibleMiningPickaxes(inventory, minTier) >= desiredPickaxes
        && (!need.torch || (inventory.torch || 0) >= need.torch)) {
        log(bot, `mineOre: inventory supplies ready (${_countEligibleMiningPickaxes(inventory, minTier)} ${minTier}+ pickaxes, ${inventory.torch || 0} torches, ${inventory.stick || 0} sticks).`);
        return true;
    }

    if (chestPos) {
        await goToPositionChunked(bot, chestPos.x, chestPos.y, chestPos.z, 2);
        inventory = world.getInventoryCounts(bot);
        const missing = _missingMiningSupplies(inventory, minTier, desiredPickaxes);
        const eligibleNames = Object.keys(MINING_PICKAXE_RANK)
            .filter(name => (MINING_PICKAXE_RANK[name] || 0) >= (MINING_TIER_RANK[minTier] || 1))
            .sort((a, b) => MINING_PICKAXE_RANK[a] - MINING_PICKAXE_RANK[b]);
        let stillNeedPickaxes = Math.max(0, desiredPickaxes - _countEligibleMiningPickaxes(inventory, minTier));
        for (const name of eligibleNames) {
            if (stillNeedPickaxes <= 0) break;
            await _takeMiningSupplyFromChest(bot, name, stillNeedPickaxes);
            stillNeedPickaxes = Math.max(0, desiredPickaxes - _countEligibleMiningPickaxes(world.getInventoryCounts(bot), minTier));
        }
        for (const [itemName, count] of Object.entries(missing)) {
            await _takeMiningSupplyFromChest(bot, itemName, count);
        }
        await _takeMiningSupplyFromChest(bot, 'stick', 16);
        if (need.torch) {
            await _takeMiningSupplyFromChest(bot, 'torch', need.torch);
            if (oreInfo.key !== 'coal') {
                await _takeMiningSupplyFromChest(bot, 'coal', 8);
            }
        }
    }

    inventory = world.getInventoryCounts(bot);
    if ((inventory.stick || 0) < 16 && (inventory.oak_planks || 0) >= 2) {
        await _tryCraftMiningSupply(bot, 'stick', 4);
    }
    inventory = world.getInventoryCounts(bot);
    if (need.torch && (inventory.torch || 0) < need.torch && (inventory.coal || 0) > 0 && (inventory.stick || 0) > 0) {
        await _tryCraftMiningSupply(bot, 'torch', Math.ceil((need.torch - (inventory.torch || 0)) / 4));
    }
    await _craftMiningPickaxesIfPossible(bot, minTier, desiredPickaxes);

    inventory = world.getInventoryCounts(bot);
    const eligiblePickaxes = _countEligibleMiningPickaxes(inventory, minTier);
    if (eligiblePickaxes < desiredPickaxes) {
        const plan = buildMiningPlanFromInventory(oreName, 1, inventory, { currentY: bot.entity.position.y });
        log(bot, formatObjectiveResult(plan));
        return false;
    }
    if (need.torch && (inventory.torch || 0) < need.torch) {
        const plan = buildMiningPlanFromInventory(oreName, 1, inventory, { currentY: bot.entity.position.y });
        log(bot, formatObjectiveResult(plan));
        return false;
    }
    log(bot, `mineOre: supplies ready (${eligiblePickaxes} ${minTier}+ pickaxes, ${inventory.torch || 0} torches, ${inventory.stick || 0} sticks).`);
    return true;
}

export async function prepareMiningRun(bot, oreName, options = {}) {
    const plan = planMiningRun(bot, oreName, 1, options);
    if (!plan.ok && plan.reason === 'unknown_ore') {
        log(bot, formatObjectiveResult(plan));
        return false;
    }
    const oreInfo = getOreInfo(oreName);
    const chestPos = plan.data.chestPos;
    if (!chestPos) {
        log(bot, formatObjectiveResult(plan));
        return false;
    }
    if (chestPos.source === 'nearby') {
        log(bot, `No home_chest saved; checking nearest chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}) for mining supplies.`);
    } else if (chestPos.source?.startsWith('base:')) {
        log(bot, `No nearby chest found; checking designated base "${chestPos.name}" at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}) for mining supplies.`);
    } else {
        log(bot, `Checking home_chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}) for mining supplies.`);
    }
    const prepared = await prepareMiningSupplies(bot, oreName, chestPos);
    if (!prepared) return false;
    const postPlan = planMiningRun(bot, oreName, 1, options);
    if (!postPlan.ok) {
        log(bot, formatObjectiveResult(postPlan));
        return false;
    }
    return true;
}

export function _directionToVec(direction) {
    switch ((direction || 'south').toLowerCase()) {
        case 'north': return { x: 0, z: -1, label: 'north' };
        case 'south': return { x: 0, z: 1,  label: 'south' };
        case 'east':  return { x: 1, z: 0,  label: 'east' };
        case 'west':  return { x: -1, z: 0, label: 'west' };
        default:      return { x: 0, z: 1,  label: 'south' };
    }
}

async function _mineExposedOres(bot, ax, ay, az, oreNames) {
    // Scan adjacent walls (foot and head levels), floor, and ceiling for matching ore.
    const scan = [
        [ax + 1, ay,     az    ], [ax - 1, ay,     az    ],
        [ax,     ay,     az + 1], [ax,     ay,     az - 1],
        [ax + 1, ay + 1, az    ], [ax - 1, ay + 1, az    ],
        [ax,     ay + 1, az + 1], [ax,     ay + 1, az - 1],
        [ax,     ay - 1, az    ], [ax,     ay + 2, az    ],
    ];
    let collected = 0;
    for (const [sx, sy, sz] of scan) {
        if (bot.interrupt_code) break;
        const block = bot.blockAt(new Vec3(sx, sy, sz));
        if (block && oreNames.includes(block.name)) {
            const ok = await breakBlockAt(bot, sx, sy, sz);
            if (ok) {
                collected++;
                await new Promise(r => setTimeout(r, 200));
                await pickupNearbyItems(bot);
            }
        }
    }
    return collected;
}

export function _isAirLike(block) {
    if (!block) return true;
    return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

export function _isPassableForCorridor(block) {
    return _isAirLike(block);
}

export function _isHazardousFluid(block) {
    if (!block) return false;
    return block.name === 'lava' || block.name === 'water' || block.name === 'flowing_lava' || block.name === 'flowing_water';
}

export function _isStandingInBlockCell(position, x, y, z) {
    if (!position) return false;
    return Math.floor(position.x) === x
        && Math.floor(position.y) === y
        && Math.floor(position.z) === z;
}

async function _goToMinedCell(bot, x, y, z, label = 'cell') {
    try {
        await goToGoal(bot, new pf.goals.GoalBlock(x, y, z));
    } catch (err) {
        log(bot, `Could not step into ${label} (${x}, ${y}, ${z}): ${err.message}.`);
        return false;
    }
    if (!_isStandingInBlockCell(bot.entity.position, x, y, z)) {
        const here = bot.entity.position;
        log(bot, `Could not step into ${label} (${x}, ${y}, ${z}); still at (${Math.floor(here.x)}, ${Math.floor(here.y)}, ${Math.floor(here.z)}).`);
        return false;
    }
    return true;
}

export async function branchMineStep(bot, dirVec, oreName) {
    /**
     * Advance one step along a 2-tall corridor in dirVec, then mine any exposed target ore.
     * Treats already-air blocks as success (so cliff/cave edges don't abort the run).
     * Bails out if the cell contains lava/water — we don't want to walk in.
     * @returns count of target-ore blocks mined this step, or null if interrupted/blocked.
     */
    const here = bot.entity.position;
    const ax = Math.floor(here.x) + dirVec.x;
    const az = Math.floor(here.z) + dirVec.z;
    const ay = Math.floor(here.y);

    // Early hazard check: don't break into lava/water and walk in.
    const headBefore = bot.blockAt(new Vec3(ax, ay + 1, az));
    const footBefore = bot.blockAt(new Vec3(ax, ay, az));
    if (_isHazardousFluid(headBefore) || _isHazardousFluid(footBefore)) {
        log(bot, `Corridor cell at (${ax}, ${ay}, ${az}) contains ${_isHazardousFluid(headBefore) ? headBefore.name : footBefore.name}; aborting step.`);
        return null;
    }

    await breakBlockAt(bot, ax, ay, az);
    if (bot.interrupt_code) return null;
    await breakBlockAt(bot, ax, ay + 1, az);
    if (bot.interrupt_code) return null;

    // Re-read post-break: only treat as failure if blocks are still solid (truly unbreakable).
    const headAfter = bot.blockAt(new Vec3(ax, ay + 1, az));
    const footAfter = bot.blockAt(new Vec3(ax, ay, az));
    if (!_isPassableForCorridor(headAfter) || !_isPassableForCorridor(footAfter)) {
        log(bot, `Corridor blocked at (${ax}, ${ay}, ${az}): head=${headAfter?.name}, foot=${footAfter?.name}. Wrong pickaxe tier or unbreakable.`);
        return null;
    }

    // Step into the cleared cell. A GoalNear radius of 1 can be satisfied from the
    // previous block, so require the bot to stand in the new block cell.
    const stepOk = await _goToMinedCell(bot, ax, ay, az, 'corridor cell');
    if (bot.interrupt_code) return null;
    if (!stepOk) {
        log(bot, `Could not step forward into (${ax}, ${ay}, ${az}).`);
        return null;
    }
    await pickupNearbyItems(bot);

    const oreNames = getOreBlockNames(oreName);
    const newHere = bot.entity.position;
    return await _mineExposedOres(
        bot,
        Math.floor(newHere.x),
        Math.floor(newHere.y),
        Math.floor(newHere.z),
        oreNames,
    );
}

export async function placeTorchOnWall(bot, dirVec) {
    /**
     * Place a torch on a side wall at head level, behind the corridor head, so the
     * bot doesn't have to backtrack and the torch isn't in the way of the next step.
     */
    if (!bot.inventory.findInventoryItem('torch')) return false;
    const here = bot.entity.position;
    const tx = Math.floor(here.x) - dirVec.x;
    const ty = Math.floor(here.y) + 1;
    const tz = Math.floor(here.z) - dirVec.z;
    try {
        return await placeBlock(bot, 'torch', tx, ty, tz, 'side');
    } catch (e) {
        return false;
    }
}

async function _staircaseStepDown(bot, dirVec, oreNamesToScan) {
    // Mine a single staircase step heading dirVec and dropping 1 in Y.
    // Bot is at (cx, cy, cz). New foot will be at (cx + dx, cy - 1, cz + dz).
    const here = bot.entity.position;
    const cy = Math.floor(here.y);
    const nx = Math.floor(here.x) + dirVec.x;
    const nz = Math.floor(here.z) + dirVec.z;
    const ny = cy - 1; // new foot Y

    // The two cells we need passable: head at (nx, ny+1=cy, nz), foot at (nx, ny, nz).
    const headBefore = bot.blockAt(new Vec3(nx, ny + 1, nz));
    const footBefore = bot.blockAt(new Vec3(nx, ny, nz));
    if (_isHazardousFluid(headBefore) || _isHazardousFluid(footBefore)) {
        const blockName = _isHazardousFluid(headBefore) ? headBefore.name : footBefore.name;
        log(bot, `Staircase step at (${nx}, ${ny}, ${nz}) hit ${blockName}; aborting.`);
        return { ok: false, reason: `fluid:${blockName}`, failurePosition: { x: nx, y: ny, z: nz }, failureBlock: blockName };
    }
    // Floor block (what the new foot stands on) at (nx, ny - 1, nz). If it's air-like or fluid,
    // we'd fall further than intended — bail.
    const floorBlock = bot.blockAt(new Vec3(nx, ny - 1, nz));
    if (!floorBlock || _isAirLike(floorBlock) || _isHazardousFluid(floorBlock)) {
        log(bot, `Staircase floor at (${nx}, ${ny - 1}, ${nz}) is ${floorBlock?.name || 'unloaded'}; aborting to avoid falling.`);
        const blockName = floorBlock?.name || 'unloaded';
        return { ok: false, reason: `floor:${blockName}`, failurePosition: { x: nx, y: ny - 1, z: nz }, failureBlock: blockName };
    }

    await breakBlockAt(bot, nx, ny, nz);
    if (bot.interrupt_code) return { ok: false, reason: 'interrupted', failurePosition: { x: nx, y: ny, z: nz } };
    await breakBlockAt(bot, nx, ny + 1, nz);
    if (bot.interrupt_code) return { ok: false, reason: 'interrupted', failurePosition: { x: nx, y: ny, z: nz } };

    const headAfter = bot.blockAt(new Vec3(nx, ny + 1, nz));
    const footAfter = bot.blockAt(new Vec3(nx, ny, nz));
    if (!_isPassableForCorridor(headAfter) || !_isPassableForCorridor(footAfter)) {
        log(bot, `Staircase blocked at (${nx}, ${ny}, ${nz}): head=${headAfter?.name}, foot=${footAfter?.name}. Wrong pickaxe tier or unbreakable.`);
        const blockName = !_isPassableForCorridor(footAfter) ? footAfter?.name : headAfter?.name;
        return { ok: false, reason: `blocked:${blockName || 'unknown'}`, failurePosition: { x: nx, y: ny, z: nz }, failureBlock: blockName || 'unknown' };
    }

    const stepOk = await _goToMinedCell(bot, nx, ny, nz, 'staircase cell');
    if (bot.interrupt_code) return { ok: false, reason: 'interrupted', failurePosition: { x: nx, y: ny, z: nz } };
    if (!stepOk) {
        log(bot, `Could not step into staircase cell (${nx}, ${ny}, ${nz}).`);
        return { ok: false, reason: 'step_into_cell_failed', failurePosition: { x: nx, y: ny, z: nz } };
    }
    await pickupNearbyItems(bot);

    if (oreNamesToScan && oreNamesToScan.length > 0) {
        const newHere = bot.entity.position;
        await _mineExposedOres(
            bot,
            Math.floor(newHere.x),
            Math.floor(newHere.y),
            Math.floor(newHere.z),
            oreNamesToScan,
        );
    }
    return { ok: true, direction: dirVec, position: { x: nx, y: ny, z: nz } };
}

function _staircaseStepSafetyAt(bot, position, dirVec) {
    const cy = Math.floor(position.y);
    const nx = Math.floor(position.x) + dirVec.x;
    const nz = Math.floor(position.z) + dirVec.z;
    const ny = cy - 1;
    const headBefore = bot.blockAt(new Vec3(nx, ny + 1, nz));
    const footBefore = bot.blockAt(new Vec3(nx, ny, nz));
    if (_isHazardousFluid(headBefore) || _isHazardousFluid(footBefore)) {
        return {
            ok: false,
            reason: `fluid:${_isHazardousFluid(headBefore) ? headBefore.name : footBefore.name}`,
            x: nx,
            y: ny,
            z: nz,
        };
    }
    const floorBlock = bot.blockAt(new Vec3(nx, ny - 1, nz));
    if (!floorBlock || _isAirLike(floorBlock) || _isHazardousFluid(floorBlock)) {
        return {
            ok: false,
            reason: `floor:${floorBlock?.name || 'unloaded'}`,
            x: nx,
            y: ny,
            z: nz,
        };
    }
    return { ok: true, x: nx, y: ny, z: nz };
}

function _staircaseStepSafety(bot, dirVec) {
    return _staircaseStepSafetyAt(bot, bot.entity.position, dirVec);
}

function _staircaseDirectionOptions(preferred) {
    const all = [
        _directionToVec(preferred?.label || 'south'),
        _directionToVec('north'),
        _directionToVec('south'),
        _directionToVec('east'),
        _directionToVec('west'),
    ];
    const seen = new Set();
    return all.filter(dir => {
        const key = `${dir.x},${dir.z}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function _chooseStaircaseDirectionAt(bot, position, preferred) {
    for (const dir of _staircaseDirectionOptions(preferred)) {
        const safety = _staircaseStepSafetyAt(bot, position, dir);
        if (safety.ok) return dir;
    }
    return null;
}

export function chooseStaircaseDirection(bot, preferred) {
    return _chooseStaircaseDirectionAt(bot, bot.entity.position, preferred);
}

function _isStandableMiningStart(bot, x, y, z) {
    const foot = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    const floor = bot.blockAt(new Vec3(x, y - 1, z));
    return _isAirLike(foot)
        && _isAirLike(head)
        && floor
        && !_isAirLike(floor)
        && !_isHazardousFluid(floor);
}

function _isNearPosition(x, y, z, pos, maxDistance) {
    if (!pos || maxDistance == null) return false;
    return Math.hypot(x - pos.x, y - pos.y, z - pos.z) <= maxDistance;
}

function _entryCandidateAt(bot, x, y, z, preferred, source, targetY = null) {
    if (!_isStandableMiningStart(bot, x, y, z)) {
        return { ok: false, reason: 'not_standable', failurePosition: { x, y, z } };
    }
    const needsDescent = targetY != null && targetY < y - 3;
    const direction = needsDescent
        ? _chooseStaircaseDirectionAt(bot, new Vec3(x, y, z), preferred)
        : preferred;
    if (!direction) {
        return { ok: false, reason: 'no_safe_descent_direction', failurePosition: { x, y, z } };
    }
    return {
        ok: true,
        entry: { x, y, z, source },
        direction,
        source,
    };
}

export function findNearbyStaircaseStart(bot, preferred, radius = 5, options = {}) {
    const here = bot.entity.position;
    const y = Math.floor(here.y);
    const originX = Math.floor(here.x);
    const originZ = Math.floor(here.z);
    const targetY = options.targetY ?? null;
    const avoidPosition = options.avoidPosition || null;
    const avoidDistance = options.avoidDistance ?? null;
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const distance = Math.abs(dx) + Math.abs(dz);
            if (distance === 0 || distance > radius) continue;
            const x = originX + dx;
            const z = originZ + dz;
            if (_isNearPosition(x, y, z, avoidPosition, avoidDistance)) continue;
            const candidate = _entryCandidateAt(bot, x, y, z, preferred, 'nearby', targetY);
            if (!candidate.ok) continue;
            candidates.push({ x, y, z, direction: candidate.direction, distance });
        }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
    return candidates[0] || null;
}

export function selectMiningEntry(bot, oreName, chestPos, options = {}) {
    const preferred = _directionToVec(options.direction || 'south');
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) {
        return { ok: false, reason: 'unknown_ore' };
    }
    const current = bot.entity.position;
    const currentY = Math.floor(current.y);
    const targetY = getBestY(oreName, currentY);
    const memoryBank = options.memoryBank || null;
    const remembered = memoryBank?.recallPlace?.('mining_entry');
    if (remembered) {
        const [x, y, z] = remembered.map(value => Math.floor(value));
        const candidate = _entryCandidateAt(bot, x, y, z, preferred, 'memory', targetY);
        if (candidate.ok) return candidate;
    }

    const currentCandidate = _entryCandidateAt(
        bot,
        Math.floor(current.x),
        currentY,
        Math.floor(current.z),
        preferred,
        'current',
        targetY,
    );
    const nearChest = _isNearPosition(
        Math.floor(current.x),
        currentY,
        Math.floor(current.z),
        chestPos,
        options.chestAvoidDistance ?? 4,
    );
    if (currentCandidate.ok && !nearChest) return currentCandidate;

    const nearby = findNearbyStaircaseStart(bot, preferred, options.searchRadius ?? 6, {
        targetY,
        avoidPosition: chestPos,
        avoidDistance: options.chestAvoidDistance ?? 4,
    });
    if (nearby) {
        return {
            ok: true,
            entry: { x: nearby.x, y: nearby.y, z: nearby.z, source: 'nearby' },
            direction: nearby.direction,
            source: 'nearby',
        };
    }

    if (currentCandidate.ok) return currentCandidate;
    return {
        ok: false,
        reason: currentCandidate.reason || 'unsafe_mining_start',
        failurePosition: currentCandidate.failurePosition || {
            x: Math.floor(current.x),
            y: currentY,
            z: Math.floor(current.z),
        },
    };
}

async function _moveToNearbyStaircaseStart(bot, preferred) {
    const start = findNearbyStaircaseStart(bot, preferred);
    if (!start) return { ok: false, reason: 'no_nearby_staircase_start' };
    log(bot, `No safe staircase step from current block; moving to nearby start (${start.x}, ${start.y}, ${start.z}) and digging ${start.direction.label}.`);
    try {
        await goToGoal(bot, new pf.goals.GoalBlock(start.x, start.y, start.z), { nonDestructiveOnly: true, failOnNoPath: true });
    } catch (err) {
        log(bot, `Could not move to nearby staircase start (${start.x}, ${start.y}, ${start.z}): ${err.message}.`);
        return { ok: false, reason: 'path_to_start_failed', failurePosition: { x: start.x, y: start.y, z: start.z } };
    }
    if (!_isStandingInBlockCell(bot.entity.position, start.x, start.y, start.z)) {
        const hereNow = bot.entity.position;
        log(bot, `Could not stand on nearby staircase start; still at (${Math.floor(hereNow.x)}, ${Math.floor(hereNow.y)}, ${Math.floor(hereNow.z)}).`);
        return { ok: false, reason: 'start_not_reached', failurePosition: { x: start.x, y: start.y, z: start.z } };
    }
    return { ok: true, direction: start.direction, entry: { x: start.x, y: start.y, z: start.z } };
}

export async function digStaircaseTo(bot, targetY, dirVec, oreNamesToScan = null) {
    /**
     * Mine a 45-degree descending staircase from the bot's current Y down to targetY.
     * Each step mines a 2-tall passage one block forward + one block down. Optionally
     * scans for the listed ore block names at each step. Descent only — for ascent use
     * goToSurface or pathfinder which can tower-up. Returns true if reached targetY.
     * @param {MinecraftBot} bot
     * @param {number} targetY
     * @param {{x:number,z:number,label:string}} dirVec
     * @param {string[]|null} [oreNamesToScan]
     * @returns {Promise<boolean>}
     */
    const startY = Math.floor(bot.entity.position.y);
    const start = {
        x: Math.floor(bot.entity.position.x),
        y: startY,
        z: Math.floor(bot.entity.position.z),
    };
    if (targetY >= startY) {
        log(bot, `digStaircaseTo: target Y=${targetY} not below current Y=${startY}; nothing to do.`);
        return { ok: true, direction: dirVec, stepsTaken: 0, start, end: start };
    }
    const totalSteps = startY - targetY;
    let activeDir = chooseStaircaseDirection(bot, dirVec);
    if (!activeDir) {
        const moved = await _moveToNearbyStaircaseStart(bot, dirVec);
        if (moved.ok) activeDir = moved.direction;
        else {
            log(bot, `No safe staircase start found near (${Math.floor(bot.entity.position.x)}, ${startY}, ${Math.floor(bot.entity.position.z)}).`);
            return { ok: false, reason: moved.reason, direction: dirVec, stepsTaken: 0, start, end: start, failure: moved };
        }
    }
    if (!activeDir) {
        log(bot, `No safe staircase start found near (${Math.floor(bot.entity.position.x)}, ${startY}, ${Math.floor(bot.entity.position.z)}).`);
        return { ok: false, reason: 'no_safe_staircase_start', direction: dirVec, stepsTaken: 0, start, end: start };
    }
    if (activeDir.label !== dirVec.label) {
        log(bot, `Staircase ${dirVec.label} is blocked at the first step; using ${activeDir.label} instead.`);
    }
    log(bot, `Building descending staircase ${activeDir.label}: ${totalSteps} steps from Y=${startY} to Y=${targetY}.`);

    const SAFETY_CAP = totalSteps + 50;
    let stepsTaken = 0;
    while (!bot.interrupt_code && stepsTaken < SAFETY_CAP) {
        const currentY = Math.floor(bot.entity.position.y);
        const currentPos = {
            x: Math.floor(bot.entity.position.x),
            y: currentY,
            z: Math.floor(bot.entity.position.z),
        };
        if (currentY <= targetY) {
            log(bot, `Staircase reached Y=${currentY}.`);
            return { ok: true, direction: activeDir, stepsTaken, start, end: currentPos };
        }
        let nextDir = chooseStaircaseDirection(bot, activeDir);
        if (!nextDir) {
            const moved = await _moveToNearbyStaircaseStart(bot, activeDir);
            if (moved.ok) nextDir = moved.direction;
            else {
                log(bot, `No safe staircase continuation found at Y=${currentY}.`);
                return { ok: false, reason: moved.reason, direction: activeDir, stepsTaken, start, end: currentPos, failure: moved };
            }
        }
        if (!nextDir) {
            log(bot, `No safe staircase continuation found at Y=${currentY}.`);
            return { ok: false, reason: 'no_safe_staircase_continuation', direction: activeDir, stepsTaken, start, end: currentPos };
        }
        if (nextDir.label !== activeDir.label) {
            log(bot, `Staircase ${activeDir.label} blocked at Y=${currentY}; turning ${nextDir.label}.`);
            activeDir = nextDir;
        }
        const step = await _staircaseStepDown(bot, activeDir, oreNamesToScan);
        if (!step.ok) {
            log(bot, `Staircase aborted at Y=${currentY} after ${stepsTaken} steps.`);
            return { ok: false, reason: step.reason, direction: activeDir, stepsTaken, start, end: currentPos, failure: step };
        }
        stepsTaken++;
    }
    if (bot.interrupt_code) {
        log(bot, `Staircase interrupted at Y=${Math.floor(bot.entity.position.y)}.`);
        return { ok: false, reason: 'interrupted', direction: activeDir, stepsTaken, start, end: {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z),
        } };
    }
    log(bot, `Staircase safety cap (${SAFETY_CAP}) reached without arriving at Y=${targetY}.`);
    return { ok: false, reason: 'safety_cap', direction: activeDir, stepsTaken, start, end: {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z),
    } };
}

export async function returnToChestAndDeposit(bot, chestPos, oreName, miningEntry, options = {}) {
    /**
     * Travel to the home chest, deposit the target ore drops + spoil blocks, then return
     * to the mining entry point so the caller can resume the corridor.
     */
    log(bot, `Inventory near full, returning to home chest.`);
    const ok = await goToPositionChunked(bot, chestPos.x, chestPos.y, chestPos.z, 2);
    if (!ok) {
        log(bot, `Could not reach home chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}).`);
        return options.detailed ? { ok: false, depositedCounts: {}, returnedToEntry: false } : false;
    }
    const oreInfo = getOreInfo(oreName);
    const dropList = ((oreInfo && ORE_DROPS[oreInfo.key]) || []).concat(SPOIL_BLOCKS);
    const depositedCounts = {};
    const countItem = (name) => (bot.inventory.items() || [])
        .filter(item => item.name === name)
        .reduce((sum, item) => sum + item.count, 0);
    for (const itemName of dropList) {
        if (bot.interrupt_code) break;
        if (bot.inventory.findInventoryItem(itemName)) {
            const before = countItem(itemName);
            await putInChest(bot, itemName, -1);
            const after = countItem(itemName);
            const deposited = Math.max(0, before - after);
            if (deposited > 0) depositedCounts[itemName] = (depositedCounts[itemName] || 0) + deposited;
        }
    }
    if (bot.interrupt_code) return options.detailed ? { ok: false, depositedCounts, returnedToEntry: false } : false;
    log(bot, `Deposit done; returning to mining entry.`);
    const returnedToEntry = await goToPositionChunked(bot, miningEntry.x, miningEntry.y, miningEntry.z, 2);
    return options.detailed ? { ok: returnedToEntry, depositedCounts, returnedToEntry } : returnedToEntry;
}

export async function mineOreAt(bot, oreName, num, options = {}) {
    /**
     * Orchestrate a mining run: validate pickaxe, save entry, descend to working Y via
     * a 45-degree staircase (no straight-down digging), branch-mine with torches,
     * return-to-chest cycles when full, stop at cumulative target count.
     * @param {MinecraftBot} bot
     * @param {string} oreName - "iron", "iron_ore", "Iron", etc.
     * @param {number} num - cumulative count of target ore drops to mine this run.
     * @param {Object} [options]
     * @param {string} [options.direction='south'] - 'north'|'south'|'east'|'west'.
     * @param {Object} [options.memoryBank] - the agent's MemoryBank for home_chest/mining_entry.
     */
    const direction = _directionToVec(options.direction || 'south');
    const objectiveUpdate = typeof options.objectiveUpdate === 'function' ? options.objectiveUpdate : null;
    const oreInfo = getOreInfo(oreName);
    if (!oreInfo) {
        log(bot, `Unknown ore: ${oreName}. Known: ${getKnownOres().join(', ')}.`);
        return false;
    }

    // Determine deposit chest.
    const memBank = options.memoryBank;
    let chestPos = getMiningHomeChestPosition(bot, memBank);
    if (!chestPos) {
        log(bot, `No home_chest set and no chest within 32 blocks. Use !rememberHere("home_chest") next to a chest first.`);
        return { ok: false, reason: 'missing_home_chest', mined: 0, target: num };
    }
    if (chestPos.source === 'nearby') {
        log(bot, `No home_chest saved; using nearest chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}) for this run.`);
    } else if (chestPos.source?.startsWith('base:')) {
        log(bot, `No nearby chest found; using designated base "${chestPos.name}" at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}) for supplies and deposits.`);
    } else {
        log(bot, `mineOre: home_chest at (${chestPos.x}, ${chestPos.y}, ${chestPos.z}).`);
    }

    const suppliesReady = await prepareMiningSupplies(bot, oreName, chestPos);
    if (!suppliesReady) {
        return { ok: false, reason: 'missing_supplies', mined: 0, target: num };
    }
    if (objectiveUpdate) objectiveUpdate('VALIDATE_PICKAXE');
    const pickCheck = botHasRequiredPickaxe(bot, oreName);
    if (!pickCheck.ok) {
        log(bot, `Need a ${pickCheck.needs} pickaxe to mine ${oreInfo.display}; you have ${pickCheck.has || 'none'}.`);
        return { ok: false, reason: 'missing_pickaxe', mined: 0, target: num };
    }
    log(bot, `mineOre: pickaxe check ok (have ${pickCheck.has}, needs ${pickCheck.needs}).`);

    const entryPlan = selectMiningEntry(bot, oreName, chestPos, {
        memoryBank: memBank,
        direction: direction.label,
    });
    if (!entryPlan.ok) {
        log(bot, `FAILED_MINING_START: ${entryPlan.reason} at ${entryPlan.failurePosition ? `(${entryPlan.failurePosition.x}, ${entryPlan.failurePosition.y}, ${entryPlan.failurePosition.z})` : 'unknown position'}.`);
        return {
            ok: false,
            reason: 'unsafe_mining_start',
            mined: 0,
            target: num,
            data: {
                failure: entryPlan.reason,
                failurePosition: entryPlan.failurePosition || null,
                targetY: getBestY(oreName, Math.floor(bot.entity.position.y)),
                currentY: Math.floor(bot.entity.position.y),
            },
        };
    }
    if (Math.floor(bot.entity.position.x) !== entryPlan.entry.x
        || Math.floor(bot.entity.position.y) !== entryPlan.entry.y
        || Math.floor(bot.entity.position.z) !== entryPlan.entry.z) {
        log(bot, `mineOre: moving to selected mining entry at (${entryPlan.entry.x}, ${entryPlan.entry.y}, ${entryPlan.entry.z}).`);
        if (objectiveUpdate) objectiveUpdate('MOVE_TO_ENTRY');
        const moved = await goToPositionChunked(bot, entryPlan.entry.x, entryPlan.entry.y, entryPlan.entry.z, 1);
        if (!moved) {
            log(bot, `FAILED_MINING_START: could not reach selected mining entry (${entryPlan.entry.x}, ${entryPlan.entry.y}, ${entryPlan.entry.z}).`);
            return {
                ok: false,
                reason: 'mining_entry_unreachable',
                mined: 0,
                target: num,
                data: {
                    failure: 'mining_entry_unreachable',
                    failurePosition: entryPlan.entry,
                },
            };
        }
    }

    // Save the mining entry so deposit cycles can return.
    const entry = bot.entity.position;
    const miningEntry = { x: Math.floor(entry.x), y: Math.floor(entry.y), z: Math.floor(entry.z) };
    let branchDirection = entryPlan.direction || direction;
    if (memBank) memBank.rememberPlace('mining_entry', miningEntry.x, miningEntry.y, miningEntry.z);
    log(bot, `mineOre: mining_entry saved at (${miningEntry.x}, ${miningEntry.y}, ${miningEntry.z}), heading ${branchDirection.label}.`);

    // Descend to the best working Y for this ore via a manual staircase. Pathfinder
    // will dig straight down if asked to descend through stone, which is what we want
    // to avoid. For ascents we do nothing — the bot is presumably already above the ore.
    const startY = Math.floor(bot.entity.position.y);
    const targetY = getBestY(oreName, startY);
    if (targetY != null && targetY < startY - 3) {
        log(bot, `mineOre: descending to working Y=${targetY} (best for ${oreInfo.display}).`);
        if (objectiveUpdate) objectiveUpdate('DESCEND');
        const descent = await digStaircaseTo(bot, targetY, branchDirection, oreInfo.block_names);
        if (!descent.ok) {
            const currentY = Math.floor(bot.entity.position.y);
            const failure = descent.failure || {};
            const failurePosition = failure.failurePosition || descent.end || null;
            const failureBlock = failure.failureBlock || null;
            log(bot, `FAILED_DESCENT: ${descent.reason || failure.reason || 'unknown'} at ${failurePosition ? `(${failurePosition.x}, ${failurePosition.y}, ${failurePosition.z})` : 'unknown position'}.`);
            log(bot, `Staircase descent did not complete; stopping before branch mining at wrong Y=${currentY}.`);
            return {
                ok: false,
                reason: 'descent_failed',
                mined: 0,
                target: num,
                data: {
                    targetY,
                    currentY,
                    failure: descent.reason || failure.reason || 'unknown',
                    failurePosition,
                    failureBlock,
                },
            };
        }
        branchDirection = descent.direction || branchDirection;
        // Update the mining entry to where we actually ended up so deposit cycles return here.
        const post = bot.entity.position;
        miningEntry.x = Math.floor(post.x);
        miningEntry.y = Math.floor(post.y);
        miningEntry.z = Math.floor(post.z);
        if (memBank) memBank.rememberPlace('mining_entry', miningEntry.x, miningEntry.y, miningEntry.z);
        log(bot, `mineOre: mining_entry updated to (${miningEntry.x}, ${miningEntry.y}, ${miningEntry.z}).`);
    } else if (targetY != null && targetY > startY + 3) {
        log(bot, `mineOre: target Y=${targetY} is above current Y=${startY}; mining here instead (no ascent staircase yet).`);
    } else {
        log(bot, `mineOre: already at working Y; starting corridor.`);
    }

    log(bot, `mineOre: branch-mining ${branchDirection.label} for ${oreInfo.display}, target ${num}.`);
    if (objectiveUpdate) objectiveUpdate('BRANCH_MINE');
    const dropKeys = ORE_DROPS[oreInfo.key] || [];
    const oreBlockNames = oreInfo.block_names || [];
    const countOreOnHand = () => {
        let total = 0;
        for (const item of bot.inventory.items()) {
            if (dropKeys.includes(item.name) || oreBlockNames.includes(item.name)) {
                total += item.count;
            }
        }
        return total;
    };

    // Cumulative tracker that survives deposits. We capture inventory deltas across
    // each iteration; positive deltas (mined more) are added, negative deltas (deposit)
    // are ignored.
    let cumulativeMined = 0;
    const depositedCounts = {};
    let lastOnHand = countOreOnHand();

    const TORCH_INTERVAL = 6;
    const MAX_STEPS = 500;
    let stepsSinceTorch = 0;
    let steps = 0;
    let exitReason = null;

    while (!bot.interrupt_code && steps < MAX_STEPS) {
        const nowOnHand = countOreOnHand();
        const delta = nowOnHand - lastOnHand;
        if (delta > 0) cumulativeMined += delta;
        lastOnHand = nowOnHand;

        if (cumulativeMined >= num) {
            exitReason = `target reached (${cumulativeMined}/${num} ${oreInfo.display})`;
            break;
        }
        if (bot.inventory.emptySlotCount() <= 2) {
            log(bot, `mineOre: inventory near full at step ${steps}, depositing.`);
            if (objectiveUpdate) objectiveUpdate('DEPOSIT');
            const deposit = await returnToChestAndDeposit(bot, chestPos, oreName, miningEntry, { detailed: true });
            for (const [itemName, count] of Object.entries(deposit.depositedCounts || {})) {
                depositedCounts[itemName] = (depositedCounts[itemName] || 0) + count;
            }
            if (!deposit.ok) {
                exitReason = `deposit cycle failed`;
                log(bot, `mineOre: deposit cycle failed; stopping.`);
                return {
                    ok: false,
                    reason: 'deposit_failed',
                    mined: cumulativeMined,
                    target: num,
                    data: { exitReason, depositedCounts },
                };
            }
            if (objectiveUpdate) objectiveUpdate('RESUME');
            // After deposit, on-hand is ~0; reset baseline so the next mining counts cleanly.
            lastOnHand = countOreOnHand();
            if (objectiveUpdate) objectiveUpdate('BRANCH_MINE');
            continue;
        }

        const collected = await branchMineStep(bot, branchDirection, oreName);
        if (collected == null) {
            exitReason = `corridor blocked at step ${steps}`;
            break;
        }
        steps++;
        stepsSinceTorch++;
        if (steps % 5 === 0) {
            log(bot, `mineOre: step ${steps}, cumulative ${cumulativeMined}/${num} ${oreInfo.display}.`);
        }

        if (stepsSinceTorch >= TORCH_INTERVAL) {
            await placeTorchOnWall(bot, branchDirection);
            stepsSinceTorch = 0;
        }
    }
    if (bot.interrupt_code) exitReason = exitReason || 'interrupted';
    if (steps >= MAX_STEPS) exitReason = exitReason || `max steps (${MAX_STEPS}) reached`;

    if (!bot.interrupt_code) {
        if (objectiveUpdate) objectiveUpdate('DEPOSIT');
        const deposit = await returnToChestAndDeposit(bot, chestPos, oreName, miningEntry, { detailed: true });
        for (const [itemName, count] of Object.entries(deposit.depositedCounts || {})) {
            depositedCounts[itemName] = (depositedCounts[itemName] || 0) + count;
        }
        if (!deposit.ok && !exitReason) exitReason = 'final deposit failed';
    }
    log(bot, `mineOre: run complete. Reason: ${exitReason}. Cumulative mined: ${cumulativeMined} ${oreInfo.display}; on hand: ${countOreOnHand()}.`);
    return {
        ok: cumulativeMined >= num,
        reason: cumulativeMined >= num ? 'target_reached' : 'partial',
        mined: cumulativeMined,
        target: num,
        data: { exitReason, steps, depositedCounts, onHand: countOreOnHand() },
    };
}
