import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import settings, { setSettings } from '../src/agent/settings.js';
import { Agent } from '../src/agent/agent.js';
import { History } from '../src/agent/history.js';
import { resolveWorldIdentity } from '../src/agent/world_identity.js';
import { getWorldMemoryPath, loadWorldMemory, saveWorldMemory } from '../src/agent/world_memory.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

const originalSettings = { ...settings };

function restoreSettings() {
    setSettings({ ...originalSettings });
}

function makeAgent() {
    const events = [];
    return {
        name: 'world_test_bot',
        bot: {
            version: '1.21.4',
            game: {
                dimension: 'overworld',
                levelType: 'default',
                serverBrand: 'vanilla',
            },
            _getDimensionName: () => 'minecraft:overworld',
        },
        transcript: {
            record(event, data, source) {
                events.push({ event, data, source });
            },
        },
        memory_bank: new MemoryBank(),
        events,
    };
}

function makeHistoryAgent(name = 'history_world_migration_bot') {
    const agent = makeAgent();
    agent.name = name;
    agent.self_prompter = {
        state: {},
        isStopped: () => true,
        prompt: null,
    };
    agent.task = { taskStartTime: 123 };
    agent.last_sender = null;
    agent.openChat = () => {};
    Object.setPrototypeOf(agent, Agent.prototype);
    return agent;
}

describe('world identity resolution', () => {
    test('configured world_id is canonical and high confidence', async () => {
        try {
            setSettings({ ...originalSettings, world_id: 'Survival Main', journeymap_bridge_url: null });
            const agent = makeAgent();
            const identity = await resolveWorldIdentity(agent);

            assert.equal(identity.world_id, 'Survival_Main');
            assert.equal(identity.source, 'settings.world_id');
            assert.equal(identity.confidence, 'high');
            assert.ok(agent.events.some(e => e.event === 'world_identity.resolve.success'));
        } finally {
            restoreSettings();
        }
    });

    test('server_path derives identity from level-name when configured', async () => {
        const dir = path.join('.', 'bots', 'tmp_world_identity_server');
        try {
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(path.join(dir, 'Forest'), { recursive: true });
            writeFileSync(path.join(dir, 'server.properties'), 'server-port=55916\nlevel-name=Forest\n');
            writeFileSync(path.join(dir, 'Forest', 'level.dat'), 'fake');
            setSettings({ ...originalSettings, world_id: null, journeymap_bridge_url: null, server_path: dir });

            const identity = await resolveWorldIdentity(makeAgent());

            assert.equal(identity.source, 'settings.server_path');
            assert.equal(identity.confidence, 'high');
            assert.match(identity.world_id, /^local_Forest_/);
            assert.equal(identity.evidence.localLevelName, 'Forest');
        } finally {
            rmSync(dir, { recursive: true, force: true });
            restoreSettings();
        }
    });

    test('protocol fallback is low confidence and deterministic', async () => {
        try {
            setSettings({ ...originalSettings, world_id: null, journeymap_bridge_url: null, server_path: null, world_path: null, host: '127.0.0.1', port: 55916 });
            const agent = makeAgent();
            const identity = await resolveWorldIdentity(agent);

            assert.equal(identity.source, 'protocol_session');
            assert.equal(identity.confidence, 'low');
            assert.match(identity.world_id, /^protocol_/);
            assert.ok(agent.events.some(e => e.event === 'world_identity.resolve.low_confidence'));
        } finally {
            restoreSettings();
        }
    });
});

describe('world memory persistence', () => {
    test('same world id reloads saved places, waypoints, routes, and storage', () => {
        const identity = {
            world_id: 'reload_world_memory',
            source: 'settings.world_id',
            confidence: 'high',
            fingerprint: 'test',
            evidence: {},
        };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const agent = makeAgent();
            loadWorldMemory(agent, identity);
            agent.memory_bank.remember('journeymap.waypoints', 'MAIN_BASE', { name: 'MAIN_BASE', x: 10, y: 64, z: -20 });
            agent.memory_bank.remember('places', 'home_chest', { name: 'home_chest', x: 11, y: 64, z: -21 });
            agent.memory_bank.remember('routes', 'mine_route', { name: 'mine_route', breadcrumbs: [{ x: 1, y: 64, z: 1 }] });
            agent.memory_bank.remember('storage', 'ore_chest', { name: 'ore_chest', x: 12, y: 64, z: -22, counts: { iron_ingot: 3 } });
            saveWorldMemory(agent);

            const loaded = makeAgent();
            loadWorldMemory(loaded, identity);

            assert.equal(loaded.memory_bank.recall('journeymap.waypoints', 'MAIN_BASE').x, 10);
            assert.equal(loaded.memory_bank.recall('places', 'home_chest').x, 11);
            assert.equal(loaded.memory_bank.recall('routes', 'mine_route').breadcrumbs.length, 1);
            assert.equal(loaded.memory_bank.recall('storage', 'ore_chest').counts.iron_ingot, 3);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('different world id does not reuse previous world memory', () => {
        const identityA = { world_id: 'world_memory_A', source: 'settings.world_id', confidence: 'high' };
        const identityB = { world_id: 'world_memory_B', source: 'settings.world_id', confidence: 'high' };
        const pathA = getWorldMemoryPath(identityA);
        const pathB = getWorldMemoryPath(identityB);
        try {
            rmSync(path.dirname(pathA), { recursive: true, force: true });
            rmSync(path.dirname(pathB), { recursive: true, force: true });
            const agent = makeAgent();
            loadWorldMemory(agent, identityA);
            agent.memory_bank.remember('places', 'MAIN_BASE', { name: 'MAIN_BASE', x: 1, y: 2, z: 3 });
            saveWorldMemory(agent);

            const other = makeAgent();
            loadWorldMemory(other, identityB);

            assert.equal(other.memory_bank.recall('places', 'MAIN_BASE'), undefined);
        } finally {
            rmSync(path.dirname(pathA), { recursive: true, force: true });
            rmSync(path.dirname(pathB), { recursive: true, force: true });
        }
    });

    test('corrupt world memory is backed up and startup can continue', () => {
        const identity = { world_id: 'corrupt_world_memory', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            mkdirSync(path.dirname(memoryPath), { recursive: true });
            writeFileSync(memoryPath, '{ not json', 'utf8');
            const agent = makeAgent();

            const result = loadWorldMemory(agent, identity);

            assert.equal(result.loaded, false);
            assert.deepEqual(agent.memory_bank.list('places'), {});
            assert.ok(agent.events.some(e => e.event === 'world_memory.load.failure'));
            assert.ok(readdirSync(path.dirname(memoryPath)).some(name => name.startsWith('memory.json.corrupt-')));
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('valid wrapper without memory_bank is backed up instead of loaded as places', () => {
        const identity = { world_id: 'partial_wrapper_world_memory', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            mkdirSync(path.dirname(memoryPath), { recursive: true });
            writeFileSync(memoryPath, JSON.stringify({
                world_identity: identity,
                saved_at: new Date().toISOString(),
            }), 'utf8');
            const agent = makeAgent();

            const result = loadWorldMemory(agent, identity);

            assert.equal(result.loaded, false);
            assert.deepEqual(agent.memory_bank.list('places'), {});
            assert.ok(agent.events.some(e => e.event === 'world_memory.load.failure'));
            assert.ok(readdirSync(path.dirname(memoryPath)).some(name => name.startsWith('memory.json.corrupt-')));
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('unknown namespace survives save and load', () => {
        const identity = { world_id: 'unknown_namespace_world', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const agent = makeAgent();
            loadWorldMemory(agent, identity);
            agent.memory_bank.loadJson({
                places: {},
                portals: {
                    nether_hub: { name: 'nether_hub', x: 0, y: 70, z: 0 },
                },
            });
            agent.memory_bank.remember('places', 'base', { name: 'base', x: 1, y: 64, z: 1 });
            saveWorldMemory(agent);

            const loaded = makeAgent();
            loadWorldMemory(loaded, identity);

            assert.equal(loaded.memory_bank.recall('portals', 'nether_hub').y, 70);
            assert.equal(loaded.memory_bank.recall('places', 'base').x, 1);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('legacy bot memory migrates once for high-confidence world identity', () => {
        const identity = { world_id: 'legacy_once_world', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const first = makeAgent();
            loadWorldMemory(first, identity, {
                legacyMemoryBank: { MAIN_BASE: [1, 64, 1] },
            });
            saveWorldMemory(first);

            const second = makeAgent();
            loadWorldMemory(second, identity, {
                legacyMemoryBank: { MAIN_BASE: [99, 64, 99] },
            });

            assert.deepEqual(second.memory_bank.recallPlace('MAIN_BASE'), [1, 64, 1]);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('legacy bot memory merges missing entries into an existing world file', () => {
        const identity = { world_id: 'legacy_merge_existing_world', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const first = makeAgent();
            loadWorldMemory(first, identity);
            first.memory_bank.remember('places', 'WORLD_BASE', { name: 'WORLD_BASE', x: 1, y: 64, z: 1 });
            saveWorldMemory(first);

            const second = makeAgent();
            const result = loadWorldMemory(second, identity, {
                legacyMemoryBank: {
                    LEGACY_MINE: [9, 11, 9],
                    WORLD_BASE: [99, 64, 99],
                },
            });

            assert.equal(result.loaded, true);
            assert.equal(result.migratedLegacy, true);
            assert.deepEqual(second.memory_bank.recallPlace('WORLD_BASE'), [1, 64, 1]);
            assert.deepEqual(second.memory_bank.recallPlace('LEGACY_MINE'), [9, 11, 9]);
            assert.equal(second.memory_bank.isDirty(), true);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('concurrent world-memory saves merge distinct bot entries', () => {
        const identity = { world_id: 'multi_bot_world_memory', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const botA = makeAgent();
            const botB = makeAgent();
            loadWorldMemory(botA, identity);
            loadWorldMemory(botB, identity);

            botA.memory_bank.remember('places', 'BOT_A_BASE', { name: 'BOT_A_BASE', x: 1, y: 64, z: 1 });
            botB.memory_bank.remember('places', 'BOT_B_BASE', { name: 'BOT_B_BASE', x: 2, y: 64, z: 2 });
            saveWorldMemory(botA);
            saveWorldMemory(botB);

            const loaded = makeAgent();
            loadWorldMemory(loaded, identity);
            assert.deepEqual(loaded.memory_bank.recallPlace('BOT_A_BASE'), [1, 64, 1]);
            assert.deepEqual(loaded.memory_bank.recallPlace('BOT_B_BASE'), [2, 64, 2]);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('migrates legacy memory only for high-confidence identity and saves world file', () => {
        const identity = {
            world_id: 'test_world_memory',
            source: 'settings.world_id',
            confidence: 'high',
            fingerprint: 'test',
            evidence: {},
        };
        const memoryPath = getWorldMemoryPath(identity);
        try {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            const agent = makeAgent();
            loadWorldMemory(agent, identity, {
                legacyMemoryBank: {
                    journeymap: {
                        waypoints: {
                            MAIN_BASE: { name: 'MAIN_BASE', x: 10, y: 64, z: -20 },
                        },
                    },
                },
            });

            assert.deepEqual(agent.memory_bank.recall('journeymap.waypoints', 'MAIN_BASE'), {
                name: 'MAIN_BASE',
                x: 10,
                y: 64,
                z: -20,
            });
            assert.equal(saveWorldMemory(agent), true);
            assert.equal(existsSync(memoryPath), true);
        } finally {
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
        }
    });

    test('History load migrates legacy bot memory into world memory end-to-end', async () => {
        const name = 'history_world_migration_bot';
        const identity = { world_id: 'history_world_migration', source: 'settings.world_id', confidence: 'high' };
        const memoryPath = getWorldMemoryPath(identity);
        const botDir = path.join('.', 'bots', name);
        try {
            rmSync(botDir, { recursive: true, force: true });
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            mkdirSync(botDir, { recursive: true });
            writeFileSync(path.join(botDir, 'memory.json'), JSON.stringify({
                memory: 'old text memory',
                turns: [],
                memory_bank: {
                    LEGACY_BASE: [7, 64, 7],
                },
            }, null, 2), 'utf8');
            setSettings({ ...originalSettings, world_id: identity.world_id, auto_sync_journeymap_on_start: false, journeymap_bridge_url: null });

            const agent = makeHistoryAgent(name);
            const history = new History(agent);
            const saveData = history.load();
            assert.equal(agent.memory_bank.recallPlace('LEGACY_BASE'), undefined);

            await Agent.prototype._initializeWorldMemory.call(agent, saveData);
            assert.deepEqual(agent.memory_bank.recallPlace('LEGACY_BASE'), [7, 64, 7]);
            assert.equal(agent.memory_bank.isDirty(), true);

            await history.save();
            const botMemory = JSON.parse(readFileSync(path.join(botDir, 'memory.json'), 'utf8'));
            const worldMemory = JSON.parse(readFileSync(memoryPath, 'utf8'));
            assert.equal(botMemory.memory_bank, undefined);
            assert.equal(worldMemory.memory_bank.places.LEGACY_BASE.x, 7);

            const second = makeHistoryAgent(name);
            const secondHistory = new History(second);
            const secondSaveData = secondHistory.load();
            await Agent.prototype._initializeWorldMemory.call(second, secondSaveData);
            assert.deepEqual(second.memory_bank.recallPlace('LEGACY_BASE'), [7, 64, 7]);
        } finally {
            rmSync(botDir, { recursive: true, force: true });
            rmSync(path.dirname(memoryPath), { recursive: true, force: true });
            restoreSettings();
        }
    });

    test('startup JourneyMap sync imports and saves waypoints when enabled', async () => {
        const originalFetch = globalThis.fetch;
        const identityDir = path.join('.', 'bots', '_worlds', 'startup_jm_world');
        try {
            rmSync(identityDir, { recursive: true, force: true });
            setSettings({ ...originalSettings, world_id: 'startup_jm_world', auto_sync_journeymap_on_start: true, journeymap_bridge_url: 'http://bridge.test' });
            globalThis.fetch = async () => ({
                ok: true,
                async text() {
                    return JSON.stringify({ waypoints: [{ name: 'MAIN_BASE', x: 10, y: 64, z: -20, dim: 0 }] });
                },
            });
            const chats = [];
            const agent = makeAgent();
            Object.setPrototypeOf(agent, Agent.prototype);
            agent.openChat = msg => chats.push(msg);

            await Agent.prototype._initializeWorldMemory.call(agent, null);

            assert.equal(agent.memory_bank.recall('journeymap.waypoints', 'MAIN_BASE').dimension, 0);
            assert.equal(agent.memory_bank.isDirty(), false);
            assert.deepEqual(chats, []);
            assert.ok(agent.events.some(e => e.event === 'journeymap.startup_sync.success'));
            const saved = JSON.parse(readFileSync(path.join(identityDir, 'memory.json'), 'utf8'));
            assert.equal(saved.memory_bank.journeymap.waypoints.MAIN_BASE.x, 10);
        } finally {
            globalThis.fetch = originalFetch;
            rmSync(identityDir, { recursive: true, force: true });
            restoreSettings();
        }
    });

    test('startup JourneyMap sync disabled does not call bridge', async () => {
        const originalFetch = globalThis.fetch;
        const identityDir = path.join('.', 'bots', '_worlds', 'startup_jm_disabled');
        try {
            rmSync(identityDir, { recursive: true, force: true });
            setSettings({ ...originalSettings, world_id: 'startup_jm_disabled', auto_sync_journeymap_on_start: false, journeymap_bridge_url: 'http://bridge.test' });
            let called = false;
            globalThis.fetch = async () => {
                called = true;
                throw new Error('should_not_fetch');
            };
            const chats = [];
            const agent = makeAgent();
            Object.setPrototypeOf(agent, Agent.prototype);
            agent.openChat = msg => chats.push(msg);

            await Agent.prototype._initializeWorldMemory.call(agent, null);

            assert.equal(called, false);
            assert.deepEqual(chats, []);
            assert.ok(agent.events.some(e => e.event === 'journeymap.startup_sync.skipped'));
        } finally {
            globalThis.fetch = originalFetch;
            rmSync(identityDir, { recursive: true, force: true });
            restoreSettings();
        }
    });

    test('startup JourneyMap sync failure is logged and non-fatal when enabled', async () => {
        const originalFetch = globalThis.fetch;
        const identityDir = path.join('.', 'bots', '_worlds', 'startup_jm_failure');
        try {
            rmSync(identityDir, { recursive: true, force: true });
            setSettings({ ...originalSettings, world_id: 'startup_jm_failure', auto_sync_journeymap_on_start: true, journeymap_bridge_url: 'http://bridge.test' });
            globalThis.fetch = async () => {
                throw new Error('bridge_down');
            };
            const chats = [];
            const agent = makeAgent();
            Object.setPrototypeOf(agent, Agent.prototype);
            agent.openChat = msg => chats.push(msg);

            await Agent.prototype._initializeWorldMemory.call(agent, null);

            assert.equal(agent.memory_bank.recall('journeymap.waypoints', 'MAIN_BASE'), undefined);
            assert.equal(chats.length, 1);
            assert.ok(agent.events.some(e => e.event === 'journeymap.startup_sync.failure'));
        } finally {
            globalThis.fetch = originalFetch;
            rmSync(identityDir, { recursive: true, force: true });
            restoreSettings();
        }
    });
});
