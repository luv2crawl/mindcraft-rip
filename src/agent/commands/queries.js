import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';
import { formatMiningPlan, planMiningRun } from '../objectives/mining_objective.js';
import { objectiveResult, formatObjectiveResult } from '../objectives/objective_results.js';
import { getWorldMemoryPath } from '../world_memory.js';

const pad = (str) => {
    return '\n' + str + '\n';
}

function formatLocationRecord(name, record) {
    const x = record?.x;
    const y = record?.y ?? '?';
    const z = record?.z;
    if (x === undefined || z === undefined) return name;
    const dim = record?.dimension ?? record?.dim;
    const dimText = dim === undefined || dim === null ? '' : ` dim:${dim}`;
    return `${name}: (${x}, ${y}, ${z})${dimText}`;
}

function formatLocationSection(title, records, limit = 20) {
    const entries = Object.entries(records || {}).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return `${title}: none`;
    const shown = entries
        .slice(0, limit)
        .map(([name, record]) => formatLocationRecord(name, record));
    const suffix = entries.length > limit ? `\n...and ${entries.length - limit} more` : '';
    return `${title}:\n${shown.join('\n')}${suffix}`;
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!objectives',
        description: 'Show the current objective stack and active high-level workflow state.',
        perform: function (agent) {
            return agent.objectives.getSummary();
        }
    },
    {
        name: '!worldMemoryStatus',
        description: 'Show the resolved world identity and durable world-memory path.',
        perform: function(agent) {
            const identity = agent.world_identity || null;
            if (!identity) {
                return formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'world_identity_missing',
                    message: 'No world identity has been resolved yet. Durable world memory may not be loaded.',
                    recommendedCommands: ['Set world_id in settings.js and restart.'],
                }));
            }
            return formatObjectiveResult(objectiveResult({
                ok: identity.confidence !== 'temporary',
                reason: identity.confidence === 'temporary' ? 'temporary_world_memory' : 'ok',
                message: [
                    `World memory id: ${identity.world_id}`,
                    `Source: ${identity.source}`,
                    `Confidence: ${identity.confidence}`,
                    `Memory path: ${agent.world_memory_path || getWorldMemoryPath(identity) || 'temporary'}`,
                ].join('\n'),
                data: {
                    world_id: identity.world_id,
                    source: identity.source,
                    confidence: identity.confidence,
                    path: agent.world_memory_path || getWorldMemoryPath(identity),
                },
            }));
        }
    },
    {
        name: '!planMiningRun',
        description: 'Plan a mining run without moving. Reports needed supplies, current inventory, missing supplies, and recommended commands.',
        params: {
            'ore_name': { type: 'string', description: 'Ore to mine, e.g. "diamond", "iron", "ancient_debris".' },
            'num': { type: 'int', description: 'How many ore drops to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, ore_name, num) {
            return formatMiningPlan(planMiningRun(agent, ore_name, num));
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations across remembered places, JourneyMap waypoints, and storage labels.',
        perform: async function (agent) {
            const places = agent.memory_bank.list('places');
            const waypoints = agent.memory_bank.list('journeymap.waypoints');
            const storage = agent.memory_bank.list('storage');
            const count = Object.keys(places).length + Object.keys(waypoints).length + Object.keys(storage).length;
            if (count === 0) {
                return formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'no_saved_locations',
                    message: 'No saved locations found in places, JourneyMap waypoints, or storage labels.',
                    recommendedCommands: [
                        '!rememberHere("base")',
                        '!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:MAIN_BASE]")',
                        '!labelNearestStorage("home_chest")',
                    ],
                }));
            }
            return formatObjectiveResult(objectiveResult({
                ok: true,
                reason: 'ok',
                message: [
                    'Saved locations:',
                    formatLocationSection('Places', places),
                    formatLocationSection('JourneyMap waypoints', waypoints),
                    formatLocationSection('Storage labels', storage),
                ].join('\n'),
                data: {
                    places: Object.keys(places).length,
                    journeyMapWaypoints: Object.keys(waypoints).length,
                    storage: Object.keys(storage).length,
                },
            }));
        }
    }, 
    {
        name: '!journeyMapWaypoints',
        description: 'List imported JourneyMap waypoints compactly.',
        perform: async function (agent) {
            const waypoints = agent.memory_bank.list('journeymap.waypoints');
            const names = Object.keys(waypoints);
            if (names.length === 0) {
                return formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'no_journeymap_waypoints',
                    message: 'No JourneyMap waypoints are imported.',
                    recommendedCommands: ['!syncJourneyMap', '!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:base]")'],
                }));
            }
            const lines = names.sort().slice(0, 20).map(name => {
                const wp = waypoints[name];
                return `${name}: (${wp.x}, ${wp.y ?? '?'}, ${wp.z}) dim:${wp.dimension ?? '?'}`;
            });
            return formatObjectiveResult(objectiveResult({
                ok: true,
                reason: 'ok',
                message: `JourneyMap waypoints:\n${lines.join('\n')}`,
                data: { count: names.length },
            }));
        }
    },
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
