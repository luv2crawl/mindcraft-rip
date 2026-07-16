import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initModes } from '../src/agent/modes.js';

function makeAgent(name, initialModes = null) {
    return {
        name,
        bot: {},
        task: null,
        prompter: {
            getInitModes() {
                return initialModes;
            }
        },
        actions: {
            currentActionLabel: ''
        },
        isIdle() {
            return true;
        }
    };
}

describe('ModeController isolation', () => {
    test('mode on/off state is per agent', () => {
        const first = makeAgent('first');
        const second = makeAgent('second');

        initModes(first);
        initModes(second);
        first.bot.modes.setOn('cheat', true);

        assert.equal(first.bot.modes.isOn('cheat'), true);
        assert.equal(second.bot.modes.isOn('cheat'), false);
    });

    test('loaded mode settings do not bleed between agents', () => {
        const first = makeAgent('first', { cheat: true });
        const second = makeAgent('second', { cheat: false });

        initModes(first);
        initModes(second);

        assert.equal(first.bot.modes.isOn('cheat'), true);
        assert.equal(second.bot.modes.isOn('cheat'), false);
    });
});
