import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, resolveMaxResponses } from '../src/agent/agent.js';
import { setSettings } from '../src/agent/settings.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import {
    createSessionMemory,
    formatSessionMemory,
    noteCommandResult,
    noteCommandStart,
    noteUserIntent,
} from '../src/agent/session_memory.js';

async function withQuietConsole(fn) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
        return await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
}

function makeAgent(response) {
    setSettings({
        language: 'en',
        max_commands: -1,
        show_command_syntax: 'full'
    });
    const historyEntries = [];
    const routed = [];
    const promptSaveCounts = [];
    let saveCount = 0;
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, {
        name: 'test_bot',
        task: { data: null },
        transcript: { record() {} },
        shut_up: false,
        blocked_actions: [],
        bot: {
            modes: {
                flushBehaviorLog() {
                    return '';
                }
            }
        },
        self_prompter: {
            shouldInterrupt() {
                return false;
            },
            handleUserPromptedCmd() {},
            isActive() {
                return false;
            }
        },
        memory_bank: new MemoryBank(),
        history: {
            async add(role, content) {
                historyEntries.push({ role, content });
            },
            async save() {
                saveCount += 1;
                agent.memory_bank?.markClean?.();
            },
            getHistory() {
                return historyEntries;
            }
        },
        prompter: {
            async promptConvo(history) {
                promptSaveCounts.push(saveCount);
                if (typeof response === 'function') {
                    return await response(history);
                }
                return response;
            }
        },
        routeResponse(_source, message) {
            routed.push(message);
        }
    });
    return { agent, historyEntries, routed, promptSaveCounts, getSaveCount: () => saveCount };
}

describe('Agent.handleMessage command responses', () => {
    test('executes all commands from one model response serially', async () => {
        const { agent, historyEntries, routed } = makeAgent('I will check. !help Then again. !help');

        const usedCommand = await withQuietConsole(() => agent.handleMessage('system', 'show help twice', 1));

        const commandResults = historyEntries.filter(entry =>
            entry.role === 'system' && entry.content.includes('*COMMAND DOCS')
        );
        assert.equal(usedCommand, true);
        assert.equal(commandResults.length, 2);
        assert.deepEqual(routed, ['I will check.  !help', '!help']);
    });

    test('executes later queued commands after a hallucinated command', async () => {
        const { agent, historyEntries } = makeAgent('Bad command first. !notACommand Then !help');

        const usedCommand = await withQuietConsole(() => agent.handleMessage('system', 'try commands', 1));

        assert.equal(usedCommand, true);
        assert.ok(historyEntries.some(entry =>
            entry.role === 'system' && entry.content === 'ERR_COMMAND_MISSING: Command !notACommand does not exist.'
        ));
        assert.equal(historyEntries.filter(entry =>
            entry.role === 'system' && entry.content.includes('*COMMAND DOCS')
        ).length, 1);
    });

    test('stores the full assistant response instead of truncating after the first command', async () => {
        const response = 'I will check. !help Then again. !help';
        const { agent, historyEntries } = makeAgent(response);

        await withQuietConsole(() => agent.handleMessage('system', 'show help twice', 1));

        assert.ok(historyEntries.some(entry =>
            entry.role === 'test_bot' && entry.content === response
        ));
    });

    test('saves dirty structured memory after a forced user command', async () => {
        const { agent, getSaveCount } = makeAgent('');

        const usedCommand = await withQuietConsole(() => agent.handleMessage(
            'miner_32',
            '!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:MAIN_BASE]")',
            1
        ));

        assert.equal(usedCommand, true);
        assert.equal(getSaveCount(), 1);
        assert.equal(agent.memory_bank.isDirty(), false);
        const waypoint = agent.memory_bank.recall('journeymap.waypoints', 'MAIN_BASE');
        assert.equal(waypoint.x, 10);
        assert.equal(waypoint.y, 64);
        assert.equal(waypoint.z, -20);
        assert.equal(waypoint.dimension, 0);
        assert.equal(waypoint.name, 'MAIN_BASE');
        assert.equal(waypoint.source, 'journeymap_import');
    });

    test('awaits history save before prompting', async () => {
        const { agent, promptSaveCounts } = makeAgent('plain response');

        await withQuietConsole(() => agent.handleMessage('system', 'hello', 1));

        assert.deepEqual(promptSaveCounts, [1]);
    });

    test('serializes overlapping handleMessage calls', async () => {
        const seenPrompts = [];
        let releaseFirst;
        const firstPromptStarted = new Promise(resolve => {
            releaseFirst = resolve;
        });
        let promptCount = 0;
        const { agent } = makeAgent(async (history) => {
            promptCount += 1;
            seenPrompts.push(history.map(entry => entry.content).join('|'));
            if (promptCount === 1) {
                await firstPromptStarted;
            }
            return `response ${promptCount}`;
        });

        const first = withQuietConsole(() => agent.handleMessage('system', 'first', 1));
        const second = withQuietConsole(() => agent.handleMessage('system', 'second', 1));
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(promptCount, 1);
        releaseFirst();
        await Promise.all([first, second]);

        assert.equal(promptCount, 2);
        assert.match(seenPrompts[0], /first/);
        assert.match(seenPrompts[1], /second/);
    });

    test('updates runtime session memory after command success and failure', async () => {
        const { agent } = makeAgent('');

        await withQuietConsole(() => agent.handleMessage(
            'miner_32',
            '!importJourneyMapLocation("[x:10, y:64, z:-20, dim:0, name:MAIN_BASE]")',
            1
        ));

        assert.equal(agent.session_memory.lastCommand, '!importJourneyMapLocation');
        assert.equal(agent.session_memory.lastCommandResultCode, 'OK');
        assert.equal(agent.session_memory.lastFailureReason, null);

        await withQuietConsole(() => agent.handleMessage(
            'miner_32',
            '!notACommand',
            1
        ));

        assert.equal(agent.session_memory.lastCommandResultCode, 'ERR_COMMAND_MISSING');
        assert.equal(agent.session_memory.lastFailureReason, 'command_missing');
    });

    test('tracks resource target from item commands without persisting session memory', async () => {
        const { agent } = makeAgent('');

        const metadata = agent._commandMetadata('!findInStorage("iron_ingot")');
        agent.session_memory = {
            currentResourceTarget: metadata.resourceTarget,
        };

        assert.equal(agent.session_memory.currentResourceTarget, 'iron_ingot');
        assert.equal(agent.memory_bank.getJson().session_memory, undefined);
    });

    test('keeps remaining mining target after one resource is completed', () => {
        const agent = { session_memory: createSessionMemory() };

        noteUserIntent(agent, 'go mine some copper and coal');
        noteCommandStart(agent, '!mineOre', { resourceTarget: 'copper' });
        noteCommandResult(agent, '!mineOre', { ok: true, code: 'OK', data: {} }, { resourceTarget: 'copper' });

        const summary = formatSessionMemory(agent.session_memory);

        assert.match(summary, /target=copper/);
        assert.match(summary, /pending=mine:coal/);
        assert.doesNotMatch(summary, /pending=mine:copper/);
    });
});

describe('Agent.handleMessage max response policy', () => {
    test('explicit max_responses still wins', () => {
        setSettings({ max_commands: -1 });

        assert.equal(resolveMaxResponses({
            requestedMaxResponses: 2,
            selfPrompt: true,
            objective: null
        }), 2);
    });

    test('normal user messages are capped to one response', () => {
        setSettings({ max_commands: -1 });

        assert.equal(resolveMaxResponses({
            requestedMaxResponses: null,
            selfPrompt: false,
            objective: { status: 'running' }
        }), 1);
    });

    test('self prompts with active objectives use configured max_commands', () => {
        setSettings({ max_commands: 4 });

        assert.equal(resolveMaxResponses({
            requestedMaxResponses: null,
            selfPrompt: true,
            objective: { status: 'in_progress' }
        }), 4);
    });

    test('self prompts without active objectives are capped to one response', () => {
        setSettings({ max_commands: -1 });

        assert.equal(resolveMaxResponses({
            requestedMaxResponses: null,
            selfPrompt: true,
            objective: null
        }), 1);
    });
});
