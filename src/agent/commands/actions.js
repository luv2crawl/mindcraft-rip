import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { runMiningObjective } from '../objectives/mining_objective.js';
import { objectiveResult, formatObjectiveResult } from '../objectives/objective_results.js';
import Vec3 from 'vec3';
import {
    fetchJourneyMapWaypoints,
    mergeJourneyMapWaypoints,
    parseJourneyMapLocation,
    postBridgeMarker,
    postBridgeWaypoint,
} from '../journeymap.js';
import {
    buildRouteRecord,
    currentPositionRecord,
    makeRouteIssue,
    shouldRecordBreadcrumb,
    summarizeRoute,
} from '../route_memory.js';
import {
    makeStorageRecord,
    searchStorage,
    storageKeyFromPosition,
} from '../storage_memory.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        let explicitReturn;
        const actionFnWithAgent = async () => {
            explicitReturn = await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (explicitReturn !== undefined && explicitReturn !== null) {
            return explicitReturn;
        }
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    };

    return wrappedAction;
}

function okResult(message, data = {}) {
    return formatObjectiveResult(objectiveResult({ ok: true, reason: 'ok', message, data }));
}

function failResult(reason, message, extras = {}) {
    return formatObjectiveResult(objectiveResult({ ok: false, reason, message, ...extras }));
}

function getKnownLocation(agent, name) {
    const place = agent.memory_bank.recall('places', name);
    if (place) return { ...place, name, source: 'places' };
    const waypoint = agent.memory_bank.recall('journeymap.waypoints', name);
    if (waypoint) return { ...waypoint, name, source: 'journeymap.waypoints' };
    const storage = agent.memory_bank.recall('storage', name);
    if (storage) return { ...storage, name, source: 'storage' };
    return null;
}

function startRouteRecorder(agent, name) {
    if (agent.routeRecordingInterval) {
        clearInterval(agent.routeRecordingInterval);
        agent.routeRecordingInterval = null;
    }
    const first = currentPositionRecord(agent.bot);
    agent.activeRouteRecording = {
        name,
        breadcrumbs: [first],
        dimension: first.dimension,
        startedAt: first.t,
    };
    agent.memory_bank.remember('pending', 'route_recording', agent.activeRouteRecording);
    agent.routeRecordingInterval = setInterval(() => {
        if (!agent.activeRouteRecording) return;
        const next = currentPositionRecord(agent.bot);
        const last = agent.activeRouteRecording.breadcrumbs.at(-1);
        if (shouldRecordBreadcrumb(last, next, 2)) {
            agent.activeRouteRecording.breadcrumbs.push(next);
            agent.activeRouteRecording.dimension = agent.activeRouteRecording.dimension || next.dimension;
            agent.memory_bank.remember('pending', 'route_recording', agent.activeRouteRecording);
        }
    }, 1000);
}

function stopRouteRecorder(agent) {
    if (agent.routeRecordingInterval) {
        clearInterval(agent.routeRecordingInterval);
        agent.routeRecordingInterval = null;
    }
    const recording = agent.activeRouteRecording || agent.memory_bank.recall('pending', 'route_recording');
    agent.activeRouteRecording = null;
    agent.memory_bank.remember('pending', 'route_recording', null);
    return recording;
}

async function captureObservation(agent, reason) {
    if (!settings.allow_vision || !agent.vision_interpreter?.allow_vision || !agent.vision_interpreter?.camera) {
        return {
            ok: false,
            reason: 'vision_unavailable',
            message: 'Vision is disabled. Enable allow_vision to capture screenshot observations.',
        };
    }
    const filename = await agent.vision_interpreter.camera.capture();
    const summary = await agent.vision_interpreter.analyzeImage(filename);
    const key = `${Date.now()}_${String(reason || 'observation').replace(/[^\w-]/g, '_')}`;
    const record = {
        reason,
        summary,
        filename,
        position: currentPositionRecord(agent.bot),
        createdAt: new Date().toISOString(),
    };
    agent.memory_bank.remember('observations', key, record);
    return { ok: true, key, record };
}

async function followRouteInternal(agent, routeName, options = {}) {
    const route = agent.memory_bank.recall('routes', routeName);
    if (!route) {
        return failResult('route_missing', `No route named "${routeName}" is saved.`, {
            recommendedCommands: [`!startRouteRecording("${routeName}")`],
        });
    }
    const currentDimension = agent.bot.game?.dimension ?? null;
    if (route.dimension && currentDimension && route.dimension !== currentDimension) {
        const issue = makeRouteIssue(routeName, 0, 'dimension_mismatch', { routeDimension: route.dimension, currentDimension });
        agent.memory_bank.remember('pending', 'route_issue', issue);
        route.lastFailure = issue;
        agent.memory_bank.remember('routes', routeName, route);
        return failResult('dimension_mismatch', `Route "${routeName}" is in ${route.dimension}, but bot is in ${currentDimension}.`);
    }

    const startSegment = options.startSegment || 0;
    const allowDigSegment = options.allowDigOnce ? startSegment : -1;
    let reached = 0;
    for (let i = startSegment; i < (route.breadcrumbs?.length || 0); i++) {
        if (agent.bot.interrupt_code) {
            const issue = makeRouteIssue(routeName, i, 'interrupted');
            agent.memory_bank.remember('pending', 'route_issue', issue);
            route.lastFailure = issue;
            agent.memory_bank.remember('routes', routeName, route);
            return failResult('interrupted', `Route "${routeName}" was interrupted at segment ${i}.`);
        }
        const point = route.breadcrumbs[i];
        const ok = i === allowDigSegment
            ? await skills.goToPositionAllowDigOnce(agent.bot, point.x, point.y, point.z, 2)
            : await skills.goToPositionNonDestructive(agent.bot, point.x, point.y, point.z, 2);
        if (!ok) {
            const issue = makeRouteIssue(routeName, i, 'route_blocked', { point });
            if (settings.allow_vision) {
                const observation = await captureObservation(agent, `route_failure_${routeName}_${i}`);
                if (observation.ok) issue.observationKey = observation.key;
            }
            agent.memory_bank.remember('pending', 'route_issue', issue);
            route.lastFailure = issue;
            agent.memory_bank.remember('routes', routeName, route);
            return failResult('route_blocked', `Route "${routeName}" is blocked at segment ${i}. I stopped before digging.`, {
                recommendedCommands: [
                    `!continueRoute("${routeName}", "retry")`,
                    `!continueRoute("${routeName}", "skip_segment")`,
                    `!continueRoute("${routeName}", "allow_dig_once")`,
                ],
                data: { segment: i },
            });
        }
        reached = i + 1;
    }
    route.lastFailure = null;
    route.updatedAt = new Date().toISOString();
    agent.memory_bank.remember('routes', routeName, route);
    agent.memory_bank.remember('pending', 'route_issue', null);
    return okResult(`Followed route "${routeName}".`, { reachedSegments: reached });
}

async function openStorageAt(agent, record) {
    await skills.goToPositionChunked(agent.bot, record.x, record.y, record.z, 2);
    const block = agent.bot.blockAt(new Vec3(record.x, record.y, record.z));
    return block;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!clearObjectives',
        description: 'Cancel the current objective stack and stop any running action.',
        perform: async function (agent) {
            await agent.actions.stop();
            const count = agent.objectives.clear();
            agent.clearBotLogs();
            agent.bot.emit('idle');
            return `Cleared ${count} objective frame${count === 1 ? '' : 's'}.`;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPositionChunked(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!syncJourneyMap',
        description: 'Import waypoints from the optional local JourneyMap bridge or local WaypointData.dat files.',
        params: {},
        perform: async function(agent) {
            try {
                const fetched = await fetchJourneyMapWaypoints();
                const sync = mergeJourneyMapWaypoints(agent.memory_bank, fetched.waypoints, { source: fetched.source });
                const imported = sync.imported + sync.updated;
                return okResult(`Imported ${imported} JourneyMap waypoint${imported === 1 ? '' : 's'}.`, {
                    imported,
                    source: fetched.source,
                    sources: fetched.sources,
                });
            } catch (err) {
                return failResult('journeymap_sync_unavailable', 'JourneyMap sync is unavailable. Configure journeymap_waypoints_path or paste a shared JourneyMap location with !importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:base]").', {
                    recommendedCommands: ['!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:base]")'],
                    data: {
                        error: err.message,
                        bridgeError: err.bridgeError?.message,
                    },
                });
            }
        }
    },
    {
        name: '!importJourneyMapLocation',
        description: 'Import a pasted JourneyMap shared location string as a waypoint.',
        params: {
            'text': { type: 'string', description: 'A JourneyMap location string like [x:10, y:64, z:-20, dim:0, name:base].' }
        },
        perform: async function(agent, text) {
            const parsed = parseJourneyMapLocation(text);
            if (!parsed.ok) {
                return failResult('invalid_journeymap_location', 'JourneyMap location must include x and z fields.', {
                    missing: parsed.missing,
                    recommendedCommands: ['!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:base]")'],
                });
            }
            agent.memory_bank.remember('journeymap.waypoints', parsed.waypoint.name, parsed.waypoint);
            return okResult(`Imported JourneyMap waypoint "${parsed.waypoint.name}".`, {
                x: parsed.waypoint.x,
                y: parsed.waypoint.y ?? 'unknown',
                z: parsed.waypoint.z,
            });
        }
    },
    {
        name: '!goToWaypoint',
        description: 'Navigate to an imported JourneyMap waypoint by name.',
        params: {
            'name': { type: 'string', description: 'The JourneyMap waypoint name.' }
        },
        perform: async function(agent, name) {
            const waypoint = agent.memory_bank.recall('journeymap.waypoints', name);
            if (!waypoint) {
                return failResult('waypoint_missing', `No JourneyMap waypoint named "${name}" is imported.`, {
                    recommendedCommands: ['!syncJourneyMap', '!journeyMapWaypoints'],
                });
            }
            const y = waypoint.y ?? agent.bot.entity.position.y;
            let result = '';
            const actionFn = async () => {
                const ok = await skills.goToPositionChunked(agent.bot, waypoint.x, y, waypoint.z, 2);
                result = ok
                    ? okResult(`Arrived near waypoint "${name}".`, { x: waypoint.x, y, z: waypoint.z })
                    : failResult('no_path', `Could not reach waypoint "${name}".`, { data: { x: waypoint.x, y, z: waypoint.z } });
            };
            const action = await agent.actions.runAction('action:goToWaypoint', actionFn, { timeout: -1 });
            return result || action.message;
        }
    },
    {
        name: '!exportWaypoint',
        description: 'Send a known place, JourneyMap waypoint, route endpoint, or storage marker to the optional JourneyMap bridge.',
        params: {
            'name': { type: 'string', description: 'The marker name to export.' }
        },
        perform: async function(agent, name) {
            const location = getKnownLocation(agent, name);
            const route = agent.memory_bank.recall('routes', name);
            const marker = location || (route?.end ? { ...route.end, name, source: 'routes' } : null);
            if (!marker) {
                return failResult('marker_missing', `No known place, waypoint, route, or storage named "${name}".`, {
                    recommendedCommands: ['!savedPlaces', '!journeyMapWaypoints'],
                });
            }
            try {
                const payload = {
                    name,
                    x: marker.x,
                    y: marker.y,
                    z: marker.z,
                    dimension: marker.dimension ?? agent.bot.game?.dimension ?? null,
                    source: marker.source || 'mindcraft',
                };
                if (marker.source === 'journeymap.waypoints') await postBridgeWaypoint(payload);
                else await postBridgeMarker(payload);
                return okResult(`Exported "${name}" to JourneyMap bridge.`, payload);
            } catch (err) {
                return failResult('journeymap_bridge_unavailable', 'JourneyMap bridge is unavailable; marker was not exported.', {
                    recommendedCommands: ['!syncJourneyMap'],
                    data: { error: err.message },
                });
            }
        }
    },
    {
        name: '!startRouteRecording',
        description: 'Start recording route breadcrumbs while the bot moves.',
        params: {
            'name': { type: 'string', description: 'The name to save the route under.' }
        },
        perform: async function(agent, name) {
            startRouteRecorder(agent, name);
            return okResult(`Started route recording "${name}".`);
        }
    },
    {
        name: '!stopRouteRecording',
        description: 'Stop recording route breadcrumbs and save the route.',
        params: {},
        perform: async function(agent) {
            const recording = stopRouteRecorder(agent);
            if (!recording) {
                return failResult('no_route_recording', 'No route recording is active.', {
                    recommendedCommands: ['!startRouteRecording("route_name")'],
                });
            }
            const route = buildRouteRecord(recording.name, recording.breadcrumbs, recording.dimension, { createdAt: recording.startedAt });
            agent.memory_bank.remember('routes', route.name, route);
            return okResult(`Saved route "${route.name}" with ${route.breadcrumbs.length} breadcrumb${route.breadcrumbs.length === 1 ? '' : 's'}.`, summarizeRoute(route));
        }
    },
    {
        name: '!followRoute',
        description: 'Follow a saved route non-destructively. If blocked, stop and ask for user approval before digging.',
        params: {
            'name': { type: 'string', description: 'The saved route name.' }
        },
        perform: async function(agent, name) {
            let result = '';
            const actionFn = async () => { result = await followRouteInternal(agent, name); };
            const action = await agent.actions.runAction('action:followRoute', actionFn, { timeout: -1 });
            return result || action.message;
        }
    },
    {
        name: '!routeStatus',
        description: 'Report route length, endpoints, last failure, and JourneyMap-linked waypoints.',
        params: {
            'name': { type: 'string', description: 'The saved route name.' }
        },
        perform: async function(agent, name) {
            const route = agent.memory_bank.recall('routes', name);
            if (!route) return failResult('route_missing', `No route named "${name}" is saved.`);
            return okResult(`Route "${name}" status.`, summarizeRoute(route));
        }
    },
    {
        name: '!continueRoute',
        description: 'Resume a blocked route after explicit user instruction. action must be retry, skip_segment, or allow_dig_once.',
        params: {
            'name': { type: 'string', description: 'The saved route name.' },
            'action': { type: 'string', description: 'retry, skip_segment, or allow_dig_once.' }
        },
        perform: async function(agent, name, action) {
            if (!['retry', 'skip_segment', 'allow_dig_once'].includes(action)) {
                return failResult('invalid_route_action', 'Use retry, skip_segment, or allow_dig_once.');
            }
            const issue = agent.memory_bank.recall('pending', 'route_issue');
            const startSegment = issue?.routeName === name
                ? issue.segmentIndex + (action === 'skip_segment' ? 1 : 0)
                : 0;
            let result = '';
            const actionFn = async () => {
                result = await followRouteInternal(agent, name, {
                    startSegment,
                    allowDigOnce: action === 'allow_dig_once',
                });
            };
            const run = await agent.actions.runAction('action:continueRoute', actionFn, { timeout: -1 });
            return result || run.message;
        }
    },
    {
        name: '!observeHere',
        description: 'Capture one vision observation for the current view and store a concise summary.',
        params: {
            'reason': { type: 'string', description: 'Why this observation is being captured.' }
        },
        perform: async function(agent, reason) {
            const observation = await captureObservation(agent, reason);
            if (!observation.ok) {
                return failResult(observation.reason, observation.message, {
                    recommendedCommands: ['Enable allow_vision in settings.js, then restart.'],
                });
            }
            return okResult(`Saved observation "${observation.key}".`, { key: observation.key });
        }
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            if (block_type === 'chest') {
                const chest = skills.getNearestStoragePosition(agent.bot, range);
                if (chest) {
                    skills.log(agent.bot, `Found chest at (${chest.x}, ${chest.y}, ${chest.z}). Navigating...`);
                    await skills.goToPosition(agent.bot, chest.x, chest.y, chest.z, 4);
                    return;
                }
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            const now = new Date().toISOString();
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z, {
                dimension: agent.bot.game?.dimension ?? null,
                source: 'remember_here',
                updatedAt: now,
                verifiedAt: now,
            });
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPositionChunked(agent.bot, pos[0], pos[1], pos[2], 2);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!depositAll',
        description: 'Deposit every stack of the named item into the nearest chest. Use this when clearing inventory; do not use !putInChest when you mean all stacks.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to deposit completely.' }
        },
        perform: runAsAction(async (agent, item_name) => {
            await skills.depositAll(agent.bot, item_name);
        })
    },
    {
        name: '!depositMiningLoot',
        description: 'Deposit mined ore drops and common mining spoil blocks into the nearest chest. Use after or during mining runs to free inventory without depositing tools/supplies.',
        params: {
            'ore_name': { type: 'string', description: 'Ore being mined, e.g. "diamond", "iron", "coal", "ancient_debris".' }
        },
        perform: runAsAction(async (agent, ore_name) => {
            await skills.depositMiningLoot(agent.bot, ore_name);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!recoverDroppedItems',
        description: 'Pick up nearby dropped item entities. Use after mining, crafting, chest overflow, or accidental drops.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.pickupNearbyItems(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftToolchainFor',
        description: 'Craft a known tool such as wooden_pickaxe, stone_pickaxe, iron_pickaxe, or diamond_pickaxe from current inventory/nearby crafting table context. Use before travel/mining; it fails fast instead of gathering missing ingredients.',
        params: {
            'tool_name': { type: 'ItemName', description: 'The exact tool to prepare, e.g. "iron_pickaxe".' }
        },
        perform: runAsAction(async (agent, tool_name) => {
            await skills.craftToolchainFor(agent.bot, tool_name);
        }, false, 5)
    },
    {
        name: '!gatherForRecipe',
        description: 'Plan missing ingredients for a recipe, then gather simple nearby block-source ingredients when possible. Use for short local prep, not long-distance mining or chest retrieval.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to craft after gathering.' },
            'num': { type: 'int', description: 'The desired output count to plan for.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.gatherForRecipe(agent.bot, item_name, num);
        }, false, 10)
    },
    {
        name: '!prepareMiningRun',
        description: 'Before walking to a mine site, check/pull/craft mining supplies from inventory or home_chest. Use this first for mining requests when the bot may need to travel before digging; it fails fast if the user needs to stock supplies.',
        params: {
            'ore_name': { type: 'string', description: 'Ore to prepare for, e.g. "iron", "diamond", "ancient_debris".' }
        },
        perform: runAsAction(async (agent, ore_name) => {
            await skills.prepareMiningRun(agent.bot, ore_name, { memoryBank: agent.memory_bank });
        }, false, 5)
    },
    {
        name: '!mineOre',
        description: 'Branch-mine for a specific ore at its best Y level. Prepares supplies from inventory/home_chest before digging, validates pickaxe tier, places torches, returns to home_chest when full, then resumes. Save a chest position as "home_chest" first via !rememberHere or !setHomeChest.',
        params: {
            'ore_name': { type: 'string', description: 'Ore to mine, e.g. "iron", "coal", "diamond", "lapis_lazuli", "ancient_debris".' },
            'num': { type: 'int', description: 'How many of the ore drops to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, ore_name, num) => {
            return await runMiningObjective(agent, ore_name, num);
        }, false, 30) // 30 minute timeout — mining is long-running
    },
    {
        name: '!setHomeChest',
        description: 'Save the position of the nearest chest (within 16 blocks) as "home_chest" for !mineOre to use as the deposit location.',
        params: {},
        perform: async function (agent) {
            const chest = skills.getNearestStoragePosition(agent.bot, 16);
            if (!chest) {
                const wider = skills.getNearestStoragePosition(agent.bot, 64);
                const data = wider
                    ? { nearest_chest_at: `(${wider.x}, ${wider.y}, ${wider.z})`, nearest_chest_distance: Math.round(Math.hypot(wider.x - agent.bot.entity.position.x, wider.y - agent.bot.entity.position.y, wider.z - agent.bot.entity.position.z)) }
                    : {};
                const recommended = wider
                    ? [`!goToCoordinates(${wider.x}, ${wider.y}, ${wider.z}, 1)`, '!setHomeChest']
                    : ['!searchForBlock("chest", 64)'];
                return formatObjectiveResult(objectiveResult({
                    ok: false,
                    reason: 'no_chest_in_range',
                    message: 'No chest within 16 blocks. Stand adjacent to a chest before saving home_chest.',
                    missing: { chest_within_16_blocks: 1 },
                    recommendedCommands: recommended,
                    data,
                }));
            }
            const dimension = agent.bot.game?.dimension ?? null;
            const now = new Date().toISOString();
            agent.memory_bank.rememberPlace('home_chest', chest.x, chest.y, chest.z, {
                dimension,
                source: 'set_home_chest',
                updatedAt: now,
                verifiedAt: now,
            });
            const block = agent.bot.blockAt(new Vec3(chest.x, chest.y, chest.z));
            agent.memory_bank.remember('storage', 'home_chest', makeStorageRecord('home_chest', block || chest, [], {
                dimension,
                source: 'set_home_chest',
                verifiedAt: now,
                block: block?.name || 'chest',
            }));
            return `Home chest saved at (${chest.x}, ${chest.y}, ${chest.z}).`;
        }
    },
    {
        name: '!labelNearestStorage',
        description: 'Save the nearest chest, trapped chest, or barrel as a named storage location.',
        params: {
            'name': { type: 'string', description: 'The storage name to save.' }
        },
        perform: async function(agent, name) {
            const block = world.getNearestStorageBlock(agent.bot, 16);
            if (!block) {
                return failResult('no_storage_in_range', 'No chest, trapped chest, or barrel within 16 blocks.', {
                    recommendedCommands: ['!searchForBlock("chest", 64)'],
                });
            }
            const record = makeStorageRecord(name, block, [], {
                dimension: agent.bot.game?.dimension ?? null,
                source: 'storage_label',
                verifiedAt: new Date().toISOString(),
            });
            agent.memory_bank.remember('storage', name, record);
            return okResult(`Saved ${block.name} as storage "${name}".`, {
                x: record.x,
                y: record.y,
                z: record.z,
            });
        }
    },
    {
        name: '!indexStorage',
        description: 'Open a named storage block, aggregate contents, and refresh its storage index.',
        params: {
            'name': { type: 'string', description: 'The storage name to index.' }
        },
        perform: async function(agent, name) {
            let result = '';
            const actionFn = async () => {
                const record = agent.memory_bank.recall('storage', name);
                if (!record) {
                    result = failResult('storage_missing', `No storage named "${name}" is saved.`, {
                        recommendedCommands: [`!labelNearestStorage("${name}")`],
                    });
                    return;
                }
                const block = await openStorageAt(agent, record);
                if (!world.isStorageBlock(block)) {
                    result = failResult('storage_block_missing', `Saved storage "${name}" is no longer a chest, trapped chest, or barrel.`);
                    return;
                }
                const container = await agent.bot.openContainer(block);
                const items = container.containerItems();
                await container.close();
                const indexed = makeStorageRecord(name, block, items, {
                    dimension: agent.bot.game?.dimension ?? null,
                });
                agent.memory_bank.remember('storage', name, indexed);
                result = okResult(`Indexed storage "${name}".`, {
                    itemTypes: Object.keys(indexed.counts).length,
                    totalItems: Object.values(indexed.counts).reduce((a, b) => a + b, 0),
                    indexedAt: indexed.indexedAt,
                });
            };
            const action = await agent.actions.runAction('action:indexStorage', actionFn, { timeout: 5 });
            return result || action.message;
        }
    },
    {
        name: '!indexStorageArea',
        description: 'Scan nearby storage blocks around a known place or waypoint and index reachable containers.',
        params: {
            'place_or_waypoint': { type: 'string', description: 'A saved place or JourneyMap waypoint to scan around.' }
        },
        perform: async function(agent, place_or_waypoint) {
            let result = '';
            const actionFn = async () => {
                const target = getKnownLocation(agent, place_or_waypoint);
                if (!target) {
                    result = failResult('location_missing', `No place, waypoint, or storage named "${place_or_waypoint}" is known.`, {
                        recommendedCommands: ['!savedPlaces', '!journeyMapWaypoints'],
                    });
                    return;
                }
                const y = target.y ?? agent.bot.entity.position.y;
                const reached = await skills.goToPositionChunked(agent.bot, target.x, y, target.z, 6);
                if (!reached) {
                    result = failResult('no_path', `Could not reach "${place_or_waypoint}" to scan storage.`);
                    return;
                }
                const blocks = world.getNearestBlocksWhere(agent.bot, block => world.isStorageBlock(block), 24, 16);
                let indexed = 0;
                for (const block of blocks) {
                    if (!block?.position) continue;
                    const key = storageKeyFromPosition(block.position);
                    const dimension = agent.bot.game?.dimension ?? null;
                    const existing = Object.entries(agent.memory_bank.list('storage')).find(([, record]) =>
                        record?.key === key && (record.dimension ?? null) === dimension
                    );
                    const name = existing?.[0] || `storage_${key}`;
                    const close = await skills.goToPositionNonDestructive(agent.bot, block.position.x, block.position.y, block.position.z, 2);
                    if (!close) continue;
                    try {
                        const container = await agent.bot.openContainer(block);
                        const items = container.containerItems();
                        await container.close();
                        agent.memory_bank.remember('storage', name, makeStorageRecord(name, block, items, {
                            dimension,
                        }));
                        indexed++;
                    } catch (err) {
                        skills.log(agent.bot, `Could not index ${name}: ${err.message}.`);
                    }
                }
                result = okResult(`Indexed ${indexed} storage container${indexed === 1 ? '' : 's'} near "${place_or_waypoint}".`, { indexed });
            };
            const action = await agent.actions.runAction('action:indexStorageArea', actionFn, { timeout: 10 });
            return result || action.message;
        }
    },
    {
        name: '!findInStorage',
        description: 'Search indexed storage memory for an item and report matching containers.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to find in indexed storage.' }
        },
        perform: async function(agent, item_name) {
            const matches = searchStorage(agent.memory_bank.list('storage'), item_name);
            if (matches.length === 0) {
                return failResult('item_not_indexed', `No indexed storage contains ${item_name}.`, {
                    recommendedCommands: ['!indexStorageArea("base")'],
                    missing: { [item_name]: 1 },
                });
            }
            const lines = matches.map(match => {
                const found = Object.entries(match.found).map(([name, count]) => `${name} x${count}`).join(', ');
                const stale = match.record.indexedAt ? `indexed ${match.record.indexedAt}` : 'not indexed recently';
                return `${match.record.name}: ${found} at (${match.record.x}, ${match.record.y}, ${match.record.z}); ${stale}`;
            });
            return okResult(`Found ${item_name} in indexed storage.\n${lines.join('\n')}`, { matches: matches.length });
        }
    },
    {
        name: '!restockFromStorage',
        description: 'Navigate to the best indexed storage container, withdraw up to the requested count, and update the index.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to withdraw.' },
            'num': { type: 'int', description: 'How many items to withdraw.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: async function(agent, item_name, num) {
            let result = '';
            const actionFn = async () => {
                const matches = searchStorage(agent.memory_bank.list('storage'), item_name)
                    .filter(match => (match.record.counts?.[item_name] || 0) > 0);
                if (matches.length === 0) {
                    result = failResult('item_not_indexed', `No indexed storage contains ${item_name}.`, {
                        missing: { [item_name]: num },
                        recommendedCommands: ['!findInStorage("' + item_name + '")', '!indexStorageArea("base")'],
                    });
                    return;
                }
                const best = matches[0].record;
                const block = await openStorageAt(agent, best);
                if (!world.isStorageBlock(block)) {
                    result = failResult('storage_block_missing', `Storage "${best.name}" is no longer accessible.`);
                    return;
                }
                const container = await agent.bot.openContainer(block);
                const matchingItems = container.containerItems().filter(item => item.name === item_name);
                const available = matchingItems.reduce((sum, item) => sum + item.count, 0);
                let remaining = Math.min(num, available);
                let taken = 0;
                for (const item of matchingItems) {
                    if (remaining <= 0) break;
                    const take = Math.min(remaining, item.count);
                    await container.withdraw(item.type, null, take);
                    taken += take;
                    remaining -= take;
                }
                const refreshed = container.containerItems();
                await container.close();
                agent.memory_bank.remember('storage', best.name, makeStorageRecord(best.name, block, refreshed, {
                    dimension: agent.bot.game?.dimension ?? null,
                }));
                if (taken < num) {
                    result = failResult('partial_restock', `Withdrew ${taken}/${num} ${item_name}; storage did not have enough.`, {
                        have: { [item_name]: taken },
                        missing: { [item_name]: num - taken },
                        data: { storage: best.name },
                    });
                } else {
                    result = okResult(`Withdrew ${taken} ${item_name} from "${best.name}".`, { storage: best.name, taken });
                }
            };
            const action = await agent.actions.runAction('action:restockFromStorage', actionFn, { timeout: 10 });
            return result || action.message;
        }
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance);
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
