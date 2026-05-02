import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { containsCommand, extractCommandMessages } from '../src/agent/commands/index.js';

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
