import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';
import { setSettings } from '../src/agent/settings.js';

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
        history: {
            async add(role, content) {
                historyEntries.push({ role, content });
            },
            save() {},
            getHistory() {
                return historyEntries;
            }
        },
        prompter: {
            async promptConvo() {
                return response;
            }
        },
        routeResponse(_source, message) {
            routed.push(message);
        }
    });
    return { agent, historyEntries, routed };
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
            entry.role === 'system' && entry.content === 'Command !notACommand does not exist.'
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
});
