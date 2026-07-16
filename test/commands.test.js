import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    blacklistCommands,
    commandExists,
    containsCommand,
    executeCommand,
    extractCommandMessages,
    getCommand,
    getCommandDocs,
    parseCommandMessage,
    normalizeCommandResult,
    renderCommandResult,
    MAX_COMMAND_RESULT_CHARS,
} from '../src/agent/commands/index.js';

describe('command extraction', () => {
    test('returns no commands when none are present', () => {
        assert.deepEqual(extractCommandMessages('hello there'), []);
        assert.equal(containsCommand('hello there'), null);
    });

    test('single command matches containsCommand compatibility API', () => {
        const commands = extractCommandMessages('checking inventory !inventory');

        assert.equal(commands.length, 1);
        assert.equal(commands[0].commandName, '!inventory');
        assert.equal(commands[0].commandText, '!inventory');
        assert.equal(containsCommand('checking inventory !inventory'), '!inventory');
    });

    test('multiple commands are returned in source order', () => {
        const commands = extractCommandMessages('first !inventory then !help');

        assert.deepEqual(commands.map(command => command.commandName), ['!inventory', '!help']);
        assert.deepEqual(commands.map(command => command.commandText), ['!inventory', '!help']);
        assert.ok(commands[0].index < commands[1].index);
    });

    test('text between commands is not merged into command arguments', () => {
        const commands = extractCommandMessages('go !goToPlayer("alex", 3) then inspect !inventory');

        assert.deepEqual(commands.map(command => command.commandText), ['!goToPlayer("alex", 3)', '!inventory']);
    });
});

describe('command result normalization', () => {
    test('legacy success strings render with OK code', () => {
        const result = normalizeCommandResult('INVENTORY\n- oak_log: 3', { commandName: '!inventory' });

        assert.equal(result.code, 'OK');
        assert.equal(result.commandName, '!inventory');
        assert.equal(renderCommandResult(result), 'OK: INVENTORY\n- oak_log: 3');
    });

    test('objective-style failures render stable ERR code', () => {
        const result = normalizeCommandResult('FAILED: no_path\nCould not reach waypoint "base".');

        assert.equal(result.ok, false);
        assert.equal(result.code, 'ERR_NO_PATH');
        assert.equal(renderCommandResult(result), 'ERR_NO_PATH: no_path\nCould not reach waypoint "base".');
    });

    test('parse and validation failures get specific codes', () => {
        assert.equal(normalizeCommandResult('Command is incorrectly formatted').code, 'ERR_BAD_FORMAT');
        assert.equal(normalizeCommandResult('Command !foo was given 1 args, but requires 2 args.').code, 'ERR_BAD_ARGS');
        assert.equal(normalizeCommandResult('Command !foo does not exist.').code, 'ERR_COMMAND_MISSING');
    });

    test('empty command results stop the loop with an explicit code', () => {
        const result = normalizeCommandResult(undefined, { commandName: '!stop' });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'ERR_EMPTY_RESULT');
        assert.equal(renderCommandResult(result), 'ERR_EMPTY_RESULT: Command returned no result.');
    });

    test('rendered command results are capped before history insertion', () => {
        const rendered = renderCommandResult('x'.repeat(MAX_COMMAND_RESULT_CHARS + 1000));

        assert.ok(rendered.length < MAX_COMMAND_RESULT_CHARS + 200);
        assert.match(rendered, /command result truncated/);
    });
});

describe('command parsing', () => {
    test('rejects trailing junk for direct parse paths', () => {
        const parsed = parseCommandMessage('!inventory trailing text');

        assert.equal(parsed, 'Command is incorrectly formatted');
    });

    test('fills documented optional parameter defaults', () => {
        const parsed = parseCommandMessage('!getCraftingPlan("torch")');

        assert.deepEqual(parsed, {
            commandName: '!getCraftingPlan',
            args: ['torch', 1]
        });
    });
});

describe('per-agent blocked commands', () => {
    test('blacklistCommands does not mutate the global command registry', () => {
        const blocked = blacklistCommands(['!help', '!stop']);
        const blockedAgent = { blocked_actions: blocked, transcript: { record: () => {} } };
        const openAgent = { blocked_actions: [], transcript: { record: () => {} } };

        assert.deepEqual(blocked, ['!help']);
        assert.equal(commandExists('!help'), true);
        assert.equal(commandExists('!help', blockedAgent), false);
        assert.equal(commandExists('!help', openAgent), true);
        assert.equal(commandExists('!stop', blockedAgent), true);
        assert.doesNotMatch(getCommandDocs(blockedAgent), /!help:/);
        assert.match(getCommandDocs(openAgent), /!help:/);
    });

    test('executeCommand rejects only the blocked agent', async () => {
        const blockedAgent = { blocked_actions: ['!help'], transcript: { record: () => {} } };
        const openAgent = { blocked_actions: [], transcript: { record: () => {} } };

        const blocked = await executeCommand(blockedAgent, '!help');
        const open = await executeCommand(openAgent, '!help');

        assert.equal(blocked.code, 'ERR_COMMAND_MISSING');
        assert.notEqual(open.code, 'ERR_COMMAND_MISSING');
        assert.match(open.raw, /\*COMMAND DOCS/);
    });
});

describe('task status command', () => {
    test('reports active task ledger state', async () => {
        const agent = {
            task_ledger: {
                current: {
                    id: 'mine_copper_1',
                    userGoal: 'mine 4 copper',
                    kind: 'mine',
                    target: 'copper',
                    status: 'blocked',
                    phase: 'VERIFY',
                    progress: { mined: 4, verified: 0, target: 4 },
                    blockedReason: 'mining_verification_failed',
                    nextAction: '!recoverDroppedItems',
                },
            },
        };

        const out = await getCommand('!taskStatus').perform(agent);

        assert.match(out, /FAILED: blocked/);
        assert.match(out, /mine 4 copper/);
        assert.match(out, /verified=0\/4/);
        assert.match(out, /Next: !recoverDroppedItems/);
    });
});
