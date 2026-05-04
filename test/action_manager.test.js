import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ActionManager } from '../src/agent/action_manager.js';

function makeAgent() {
    const events = [];
    return {
        events,
        bot: {
            interrupt_code: false,
            output: '',
            emit(event) {
                events.push(['emit', event]);
            }
        },
        transcript: {
            record(event, data, source) {
                events.push(['transcript', event, data, source]);
            }
        },
        clearBotLogs() {
            this.bot.output = '';
            this.bot.interrupt_code = false;
        },
        requestInterrupt() {
            this.bot.interrupt_code = true;
        },
        cleanKill(message) {
            events.push(['cleanKill', message]);
        }
    };
}

describe('ActionManager interruption handling', () => {
    test('treats errors thrown after interrupt as interrupted, not failures', async () => {
        const agent = makeAgent();
        const actions = new ActionManager(agent);

        const result = await actions.runAction('action:test', async () => {
            agent.bot.interrupt_code = true;
            throw new Error('PathStopped: Path was stopped before it could be completed!');
        });

        assert.deepEqual(result, {
            success: false,
            message: '',
            interrupted: true,
            timedout: false
        });
        assert.ok(agent.events.some(entry =>
            entry[0] === 'transcript' &&
            entry[1] === 'action.end' &&
            entry[2].interrupted === true
        ));
        assert.ok(!agent.events.some(entry => entry[0] === 'transcript' && entry[1] === 'action.failure'));
        assert.equal(actions.executing, false);
        assert.equal(actions.currentActionLabel, '');
    });
});
