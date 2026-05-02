import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'fs';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { History } from '../src/agent/history.js';
import { parseJourneyMapLocation, normalizeBridgeWaypoint } from '../src/agent/journeymap.js';
import { aggregateContainerItems, searchStorage } from '../src/agent/storage_memory.js';
import { buildRouteRecord, makeRouteIssue, shouldRecordBreadcrumb } from '../src/agent/route_memory.js';

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

    test('searches typed namespaces by key and value text', () => {
        const bank = new MemoryBank();
        bank.remember('storage', 'food_barrel', { counts: { cooked_beef: 12 } });
        bank.remember('storage', 'stone_chest', { counts: { cobblestone: 64 } });

        assert.deepEqual(Object.keys(bank.search('storage', 'beef')), ['food_barrel']);
        assert.deepEqual(Object.keys(bank.search('storage', 'stone')), ['stone_chest']);
    });

    test('History save/load persists typed memory bank through memory.json', async () => {
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
        const history = new History(agent);
        await history.save();

        const loadedAgent = makeAgent();
        const loadedHistory = new History(loadedAgent);
        loadedHistory.load();

        assert.deepEqual(loadedAgent.memory_bank.recall('journeymap.waypoints', 'base'), { x: 10, y: 64, z: -20 });
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
});
