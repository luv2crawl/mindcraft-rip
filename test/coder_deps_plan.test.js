import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Coder } from '../src/agent/coder.js';

function makeCoder({
    plannerResponse = '{"goal":"build hut","sub_goals":["place floor"],"selected_sub_goal":"place floor","selection_reason":"start with foundation"}',
    codingResponses = ['```js\nawait skills.wait(bot, 1);\n```']
} = {}) {
    const calls = [];
    const transcriptEvents = [];
    const agent = {
        bot: {
            interrupt_code: false,
            modes: {
                paused: false,
                pause(mode) {
                    this.paused = true;
                    calls.push(['pause', mode]);
                },
                isPaused() {
                    return this.paused;
                },
                unpause(mode) {
                    this.paused = false;
                    calls.push(['unpause', mode]);
                }
            }
        },
        actions: {
            getBotOutputSummary() {
                return 'Action output:\nplaced floor';
            }
        },
        transcript: {
            record(event, data, source) {
                transcriptEvents.push({ event, data, source });
            }
        },
        prompter: {
            async promptNewActionPlan(messages) {
                calls.push(['plan', messages.map(msg => msg.content)]);
                return plannerResponse;
            },
            async promptCoding(messages) {
                calls.push(['code', messages.map(msg => msg.content)]);
                return codingResponses[Math.min(calls.filter(call => call[0] === 'code').length - 1, codingResponses.length - 1)];
            }
        }
    };
    const coder = Object.create(Coder.prototype);
    Object.assign(coder, {
        agent,
        async _stageCode() {
            calls.push(['stage']);
            return {
                func: {
                    async main() {
                        calls.push(['execute']);
                    }
                },
                src_lint_copy: 'await skills.wait(bot, 1);'
            };
        },
        async _lintCode() {
            calls.push(['lint']);
            return null;
        },
        _sanitizeCode(code) {
            return code.trim();
        }
    });
    return { coder, calls, transcriptEvents };
}

describe('Coder DEPS planning stage', () => {
    test('plans before coding and injects selected sub-goal context', async () => {
        const { coder, calls, transcriptEvents } = makeCoder();
        const history = {
            getHistory() {
                return [
                    { role: 'user', content: 'build a hut !newAction("Build a small hut")' }
                ];
            }
        };

        const result = await coder.generateCode(history);

        assert.ok(result.includes('Agent wrote this code'));
        const planIndex = calls.findIndex(call => call[0] === 'plan');
        const codeIndex = calls.findIndex(call => call[0] === 'code');
        assert.ok(planIndex > -1);
        assert.ok(codeIndex > planIndex);
        const codingMessages = calls[codeIndex][1];
        assert.ok(codingMessages.some(content => content.includes('DEPS plan for this !newAction')));
        assert.ok(codingMessages.some(content => content.includes('Write code only for selected_sub_goal now.')));
        assert.ok(transcriptEvents.some(entry => entry.event === 'code.plan.generated' && entry.source === 'coder'));
        assert.ok(calls.some(call => call[0] === 'unpause' && call[1] === 'unstuck'));
    });

    test('falls back to the requested action when planner returns empty text', async () => {
        const { coder, calls, transcriptEvents } = makeCoder({ plannerResponse: '' });
        const history = {
            getHistory() {
                return [
                    { role: 'user', content: 'please !newAction("Build a bridge")' }
                ];
            }
        };

        await coder.generateCode(history);

        const codeCall = calls.find(call => call[0] === 'code');
        assert.ok(codeCall[1].some(content => content.includes('"Build a bridge"')));
        assert.ok(transcriptEvents.some(entry =>
            entry.event === 'code.plan.generated' && entry.data.fallback === true
        ));
    });

    test('rejects loop syntax before staging code', async () => {
        const { coder, calls, transcriptEvents } = makeCoder({
            codingResponses: ['```js\nwhile (1) {}\n```']
        });
        const history = {
            getHistory() {
                return [
                    { role: 'user', content: 'please !newAction("Loop forever")' }
                ];
            }
        };

        const result = await coder.generateCode(history);

        assert.equal(result, 'Code generation failed after 5 attempts.');
        assert.equal(calls.some(call => call[0] === 'stage'), false);
        assert.ok(calls.some(call => call[0] === 'unpause' && call[1] === 'unstuck'));
        assert.ok(transcriptEvents.some(entry => entry.event === 'code.validation.failure'));
    });

    test('does not unpause unstuck when it was already paused', async () => {
        const { coder, calls } = makeCoder();
        coder.agent.bot.modes.paused = true;
        const history = {
            getHistory() {
                return [
                    { role: 'user', content: 'please !newAction("Build a bridge")' }
                ];
            }
        };

        await coder.generateCode(history);

        assert.equal(calls.some(call => call[0] === 'unpause'), false);
        assert.equal(coder.agent.bot.modes.paused, true);
    });
});
