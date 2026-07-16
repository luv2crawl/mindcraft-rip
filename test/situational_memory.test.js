import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'fs';
import nbt from 'prismarine-nbt';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { History } from '../src/agent/history.js';
import { parseJourneyMapLocation, normalizeBridgeWaypoint, mergeJourneyMapWaypoints, parseJourneyMapWaypointData } from '../src/agent/journeymap.js';
import { aggregateContainerItems, makeStorageRecord, searchStorage } from '../src/agent/storage_memory.js';
import { buildRouteRecord, makeRouteIssue, shouldRecordBreadcrumb } from '../src/agent/route_memory.js';
import { getCommand } from '../src/agent/commands/index.js';
import { recordMiningCompletion } from '../src/agent/objectives/mining_objective.js';

describe('MemoryBank typed memory', () => {
    test('migrates old flat place memory into places namespace', () => {
        const bank = new MemoryBank();
        bank.loadJson({
            base: [10, 64, -20],
            mine: { x: 2, y: 11, z: 3 },
        });

        assert.deepEqual(bank.recallPlace('base'), [10, 64, -20]);
        assert.deepEqual(bank.recall('places', 'base'), { name: 'base', x: 10, y: 64, z: -20 });
        assert.deepEqual(bank.recall('places', 'mine'), { name: 'mine', x: 2, y: 11, z: 3 });
        assert.deepEqual(bank.list('routes'), {});
    });

    test('typed memory round-trips and repairs missing namespaces', () => {
        const bank = new MemoryBank();
        bank.loadJson({
            places: { base: [1, 2, 3] },
            journeymap: {},
            routes: { tunnel: { breadcrumbs: [] } },
        });
        bank.remember('journeymap.waypoints', 'home', { x: 4, y: 5, z: 6 });

        const data = bank.getJson();
        const next = new MemoryBank();
        next.loadJson(data);

        assert.deepEqual(next.recallPlace('base'), [1, 2, 3]);
        assert.deepEqual(next.recall('journeymap.waypoints', 'home'), { x: 4, y: 5, z: 6 });
        assert.deepEqual(next.recall('routes', 'tunnel'), { breadcrumbs: [] });
        assert.deepEqual(next.list('storage'), {});
    });

    test('dirty flag tracks structured memory writes and loads', () => {
        const bank = new MemoryBank();

        assert.equal(bank.isDirty(), false);
        bank.remember('journeymap.waypoints', 'home', { x: 4, y: 5, z: 6 });
        assert.equal(bank.isDirty(), true);

        bank.markClean();
        assert.equal(bank.isDirty(), false);

        bank.loadJson({ places: { base: [1, 2, 3] } });
        assert.equal(bank.isDirty(), false);
    });

    test('searches typed namespaces by key and value text', () => {
        const bank = new MemoryBank();
        bank.remember('storage', 'food_barrel', { counts: { cooked_beef: 12 } });
        bank.remember('storage', 'stone_chest', { counts: { cobblestone: 64 } });

        assert.deepEqual(Object.keys(bank.search('storage', 'beef')), ['food_barrel']);
        assert.deepEqual(Object.keys(bank.search('storage', 'stone')), ['stone_chest']);
    });

    test('rejects unsafe memory keys and skips unsafe loaded keys', () => {
        const bank = new MemoryBank();

        assert.throws(
            () => bank.remember('places', '__proto__', { polluted: true }),
            /Unsafe memory key/
        );
        assert.equal({}.polluted, undefined);

        bank.loadJson(JSON.parse(`{
            "places": {
                "__proto__": { "polluted": true },
                "base": { "name": "base", "x": 1, "y": 64, "z": 1 }
            },
            "storage": {
                "chest": {
                    "name": "chest",
                    "__proto__": { "polluted": true }
                }
            },
            "__proto__": { "polluted": true }
        }`));

        assert.equal({}.polluted, undefined);
        assert.equal(bank.recall('places', '__proto__'), undefined);
        assert.equal(bank.recall('places', 'base').x, 1);
        assert.equal(bank.recall('storage', 'chest').polluted, undefined);
        assert.equal(bank.recall('storage', 'chest').name, 'chest');
    });

    test('rejects unsafe memory namespaces', () => {
        const bank = new MemoryBank();

        assert.throws(
            () => bank.remember('journeymap.__proto__', 'home', { x: 1, y: 2, z: 3 }),
            /Unsafe memory namespace/
        );
        assert.equal({}.home, undefined);
    });

    test('savedPlaces reports places, JourneyMap waypoints, and storage labels', async () => {
        const bank = new MemoryBank();
        bank.rememberPlace('base', 1, 64, 2);
        bank.remember('journeymap.waypoints', 'MAIN_BASE', { name: 'MAIN_BASE', x: 10, y: 65, z: -20, dimension: 0 });
        bank.remember('storage', 'home_chest', { name: 'home_chest', x: 11, y: 65, z: -21, block: 'chest' });

        const out = await getCommand('!savedPlaces').perform({ memory_bank: bank });

        assert.match(out, /^OK: ok/);
        assert.match(out, /Places:\nbase: \(1, 64, 2\)/);
        assert.match(out, /JourneyMap waypoints:\nMAIN_BASE: \(10, 65, -20\) dim:0/);
        assert.match(out, /Storage labels:\nhome_chest: \(11, 65, -21\)/);
    });

    test('rememberHere stores durable place metadata and preserves dimension zero', async () => {
        const bank = new MemoryBank();
        const out = await getCommand('!rememberHere').perform({
            memory_bank: bank,
            bot: {
                entity: { position: { x: 1, y: 64, z: 2 } },
                game: { dimension: 0 },
            },
        }, 'spawn');
        const record = bank.recall('places', 'spawn');

        assert.match(out, /Location saved/);
        assert.equal(record.dimension, 0);
        assert.equal(record.source, 'remember_here');
        assert.ok(record.updatedAt);
        assert.ok(record.verifiedAt);
    });

    test('History save does not persist typed memory bank through bot memory.json', async () => {
        const name = 'memory_bank_roundtrip_test';
        const dir = `./bots/${name}`;
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

        const makeAgent = () => ({
            name,
            memory_bank: new MemoryBank(),
            self_prompter: {
                state: {},
                isStopped: () => true,
                prompt: null,
            },
            task: { taskStartTime: 123 },
            last_sender: null,
            transcript: { record: () => {} },
        });

        const agent = makeAgent();
        agent.memory_bank.remember('journeymap.waypoints', 'base', { x: 10, y: 64, z: -20 });
        assert.equal(agent.memory_bank.isDirty(), true);
        const history = new History(agent);
        await history.save();
        assert.equal(agent.memory_bank.isDirty(), true);

        const saved = JSON.parse(readFileSync(`${dir}/memory.json`, 'utf8'));
        assert.equal(saved.memory_bank, undefined);

        rmSync(dir, { recursive: true, force: true });
    });
});

describe('JourneyMap parsing', () => {
    test('parses valid location strings with reordered fields', () => {
        const parsed = parseJourneyMapLocation('[z:-20, name:base, x:10, dim:0, y:64]');

        assert.equal(parsed.ok, true);
        assert.equal(parsed.waypoint.name, 'base');
        assert.equal(parsed.waypoint.x, 10);
        assert.equal(parsed.waypoint.y, 64);
        assert.equal(parsed.waypoint.z, -20);
        assert.equal(parsed.waypoint.dimension, 0);
    });

    test('rejects strings missing x or z', () => {
        const parsed = parseJourneyMapLocation('[y:64, name:bad]');

        assert.equal(parsed.ok, false);
        assert.equal(parsed.reason, 'missing_coordinates');
        assert.deepEqual(parsed.missing, { x: 1, z: 1 });
    });

    test('normalizes bridge waypoint shapes', () => {
        assert.deepEqual(normalizeBridgeWaypoint({
            id: 'portal',
            pos: { x: 1, y: 70, z: 2 },
            dim: 'minecraft:overworld',
        }).name, 'portal');

        assert.equal(normalizeBridgeWaypoint({ name: 'bad', x: 1 }), null);
    });

    test('merges bridge waypoints while preserving existing labels', () => {
        const bank = new MemoryBank();
        bank.remember('journeymap.waypoints', 'MAIN_BASE', {
            name: 'MAIN_BASE',
            label: 'Main base',
            x: 0,
            y: 64,
            z: 0,
        });
        bank.markClean();

        const stats = mergeJourneyMapWaypoints(bank, [
            { name: 'MAIN_BASE', x: 10, y: 65, z: -20, dim: 0 },
        ], { source: 'journeymap_bridge_startup' });
        const waypoint = bank.recall('journeymap.waypoints', 'MAIN_BASE');

        assert.equal(stats.updated, 1);
        assert.equal(waypoint.label, 'Main base');
        assert.equal(waypoint.source, 'journeymap_bridge_startup');
        assert.equal(waypoint.dimension, 0);
        assert.ok(waypoint.updatedAt);
        assert.ok(waypoint.verifiedAt);
    });

    test('parses JourneyMap WaypointData.dat NBT files', async () => {
        const sample = nbt.writeUncompressed({
            type: 'compound',
            name: '',
            value: {
                waypoints: {
                    type: 'compound',
                    value: {
                        '7e85d601-23da-47e3-9ecd-523308718e73': {
                            type: 'compound',
                            value: {
                                settings: {
                                    type: 'compound',
                                    value: {
                                        enable: { type: 'byte', value: 1 },
                                    },
                                },
                                pos: {
                                    type: 'compound',
                                    value: {
                                        x: { type: 'int', value: -411 },
                                        y: { type: 'int', value: 65 },
                                        z: { type: 'int', value: 15 },
                                        dimension: { type: 'string', value: 'minecraft:overworld' },
                                    },
                                },
                                name: { type: 'string', value: 'HOME_CHEST' },
                                guid: { type: 'string', value: '7e85d601-23da-47e3-9ecd-523308718e73' },
                            },
                        },
                    },
                },
            },
        });
        const parsed = await parseJourneyMapWaypointData(sample, { sourcePath: 'WaypointData.dat' });

        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].name, 'HOME_CHEST');
        assert.equal(parsed[0].x, -411);
        assert.equal(parsed[0].y, 65);
        assert.equal(parsed[0].z, 15);
        assert.equal(parsed[0].dimension, 'minecraft:overworld');
    });
});

describe('Routes and storage helpers', () => {
    test('recording saves breadcrumbs and metadata', () => {
        const route = buildRouteRecord('tunnel', [
            { x: 0, y: 64, z: 0, t: 'a' },
            { x: 3, y: 64, z: 0, t: 'b' },
        ], 'overworld');

        assert.equal(route.name, 'tunnel');
        assert.equal(route.breadcrumbs.length, 2);
        assert.deepEqual(route.start, { x: 0, y: 64, z: 0, t: 'a' });
        assert.deepEqual(route.end, { x: 3, y: 64, z: 0, t: 'b' });
        assert.equal(route.dimension, 'overworld');
    });

    test('blocked segment creates pending route issue shape', () => {
        const issue = makeRouteIssue('tunnel', 4, 'route_blocked', { point: { x: 1, y: 2, z: 3 } });

        assert.equal(issue.type, 'route_issue');
        assert.equal(issue.routeName, 'tunnel');
        assert.equal(issue.segmentIndex, 4);
        assert.equal(issue.reason, 'route_blocked');
    });

    test('breadcrumb distance threshold works', () => {
        assert.equal(shouldRecordBreadcrumb(null, { x: 0, y: 0, z: 0 }), true);
        assert.equal(shouldRecordBreadcrumb({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 2), false);
        assert.equal(shouldRecordBreadcrumb({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 2), true);
    });

    test('storage index aggregates stack totals and searches matches', () => {
        const counts = aggregateContainerItems([
            { name: 'torch', count: 12 },
            { name: 'torch', count: 20 },
            { name: 'oak_log', count: 3 },
        ]);
        assert.deepEqual(counts, { torch: 32, oak_log: 3 });

        const matches = searchStorage({
            chest_a: { name: 'chest_a', counts, x: 1, y: 2, z: 3 },
            chest_b: { name: 'chest_b', counts: { dirt: 64 }, x: 4, y: 5, z: 6 },
        }, 'torch');
        assert.equal(matches.length, 1);
        assert.equal(matches[0].record.name, 'chest_a');
        assert.deepEqual(matches[0].found, { torch: 32 });
    });

    test('storage records carry contentsIndexedAt while keeping indexedAt compatibility', () => {
        const record = makeStorageRecord('ore_chest', {
            name: 'chest',
            position: { x: 1, y: 2, z: 3 },
        }, [{ name: 'iron_ingot', count: 9 }], {
            dimension: 0,
            source: 'test',
        });

        assert.equal(record.dimension, 0);
        assert.equal(record.contentsIndexedAt, record.indexedAt);
        assert.equal(record.updatedAt.length > 0, true);
        assert.equal(record.source, 'test');
    });

    test('mining completion updates home chest storage counts', () => {
        const memory_bank = new MemoryBank();
        memory_bank.remember('storage', 'home_chest', {
            name: 'home_chest',
            x: 1,
            y: 64,
            z: 2,
            counts: {},
        });
        memory_bank.markClean();

        recordMiningCompletion({ memory_bank }, 'copper', {
            ok: true,
            data: {
                mined: 16,
                target: 16,
            },
        });

        const storage = memory_bank.recall('storage', 'home_chest');
        assert.equal(storage.counts.raw_copper, 16);
        assert.equal(storage.source, 'mining_objective');
        assert.equal(Object.keys(memory_bank.list('observations')).length, 1);
        assert.equal(memory_bank.isDirty(), true);
    });
});
