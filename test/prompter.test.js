import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prompter } from '../src/models/prompter.js';
import { MemoryBank } from '../src/agent/memory_bank.js';

describe('Prompter replacement caching', () => {
    test('reuses cached examples across replacement retries', async () => {
        const prompter = Object.create(Prompter.prototype);
        prompter.agent = { name: 'bot' };
        let calls = 0;
        const examples = {
            async createExampleMessage() {
                calls++;
                return 'example text';
            }
        };
        const cache = new Map();

        const first = await prompter.replaceStrings('$NAME\n$EXAMPLES', [], examples, [], null, cache);
        const second = await prompter.replaceStrings('$NAME\n$EXAMPLES', [], examples, [], null, cache);

        assert.equal(first, 'bot\nexample text');
        assert.equal(second, 'bot\nexample text');
        assert.equal(calls, 1);
    });

    test('injects compact structured memory with text memory', async () => {
        const memoryBank = new MemoryBank();
        memoryBank.remember('journeymap.waypoints', 'MAIN_BASE', {
            name: 'MAIN_BASE',
            x: 10,
            y: 64,
            z: -20,
            dimension: 0,
        });
        const prompter = Object.create(Prompter.prototype);
        prompter.agent = {
            name: 'bot',
            history: { memory: 'User wants mining runs to use base storage.' },
            memory_bank: memoryBank,
        };

        const out = await prompter.replaceStrings('Memory:\n$MEMORY', []);

        assert.match(out, /User wants mining runs to use base storage/);
        assert.match(out, /Structured memory:/);
        assert.match(out, /JourneyMap waypoints: MAIN_BASE\(10,64,-20 dim:0\)/);
    });

    test('does not feed structured memory into saving_memory prompts', async () => {
        const memoryBank = new MemoryBank();
        memoryBank.remember('journeymap.waypoints', 'MAIN_BASE', {
            name: 'MAIN_BASE',
            x: 10,
            y: 64,
            z: -20,
        });
        const prompter = Object.create(Prompter.prototype);
        Object.assign(prompter, {
            agent: {
                name: 'bot',
                history: { memory: 'Use the base for mining.' },
                memory_bank: memoryBank,
                transcript: { record() {} },
            },
            profile: {
                saving_memory: "Old Memory: '$MEMORY'\n$TO_SUMMARIZE",
            },
            chat_model: {
                model_name: 'test',
                async sendRequest(_messages, prompt) {
                    return prompt;
                },
            },
            async checkCooldown() {},
            async _saveLog() {},
        });

        const prompt = await prompter.promptMemSaving([{ role: 'user', content: 'hello' }]);

        assert.match(prompt, /Use the base for mining/);
        assert.doesNotMatch(prompt, /MAIN_BASE/);
        assert.doesNotMatch(prompt, /Structured memory/);
    });

    test('structured memory ranking includes relevant labels past alphabetical cutoff', async () => {
        const memoryBank = new MemoryBank();
        for (let i = 0; i < 12; i++) {
            memoryBank.remember('journeymap.waypoints', `aaa_${i}`, { x: i, y: 64, z: i });
        }
        memoryBank.remember('journeymap.waypoints', 'ZZZ_IRON_BASE', {
            name: 'ZZZ_IRON_BASE',
            x: 99,
            y: 64,
            z: -99,
            aliases: ['iron base'],
        });
        const summary = memoryBank.getPromptSummary({ latestMessage: 'mine iron from iron base' });

        assert.match(summary, /ZZZ_IRON_BASE\(99,64,-99\)/);
    });

    test('structured memory prefers storage containing requested item', async () => {
        const memoryBank = new MemoryBank();
        for (let i = 0; i < 12; i++) {
            memoryBank.remember('storage', `aaa_${i}`, {
                name: `aaa_${i}`,
                x: i,
                y: 64,
                z: i,
                counts: { dirt: 64 },
            });
        }
        memoryBank.remember('storage', 'ZZZ_IRON_CHEST', {
            name: 'ZZZ_IRON_CHEST',
            x: 77,
            y: 65,
            z: -12,
            counts: { iron_ingot: 18 },
            contentsIndexedAt: '2026-01-01T00:00:00.000Z',
        });

        const summary = memoryBank.getPromptSummary({
            latestMessage: 'restock iron ingot',
            currentResourceTarget: 'iron_ingot',
        });

        assert.match(summary, /ZZZ_IRON_CHEST\(77,65,-12\)/);
    });

    test('missing home chest result surfaces recovery memory and session context', async () => {
        const memoryBank = new MemoryBank();
        for (let i = 0; i < 10; i++) {
            memoryBank.remember('journeymap.waypoints', `aaa_${i}`, { x: i, y: 64, z: i });
        }
        memoryBank.remember('journeymap.waypoints', 'MAIN_BASE', {
            name: 'MAIN_BASE',
            x: 10,
            y: 64,
            z: -20,
        });
        memoryBank.remember('storage', 'home_chest', {
            name: 'home_chest',
            x: 11,
            y: 64,
            z: -21,
            counts: { torch: 12 },
        });
        const prompter = Object.create(Prompter.prototype);
        prompter.agent = {
            name: 'bot',
            history: { memory: '' },
            memory_bank: memoryBank,
            session_memory: {
                lastCommand: '!mineOre',
                currentResourceTarget: 'torch',
                lastCommandResultCode: 'ERR_MISSING_HOME_CHEST',
                lastFailureReason: 'missing_home_chest',
                nextRecommendedRecoveryCommand: '!setHomeChest',
                lastCommandResultData: {},
            },
        };

        const out = await prompter.replaceStrings('$STRUCTURED_MEMORY', []);

        assert.match(out, /Current session:/);
        assert.match(out, /last_result=ERR_MISSING_HOME_CHEST/);
        assert.match(out, /MAIN_BASE\(10,64,-20\)/);
        assert.match(out, /home_chest\(11,64,-21\)/);
        assert.deepEqual(prompter.agent.session_memory.lastSurfacedMemoryLabels.some(label => label.includes('home_chest')), true);
    });

    test('task ledger summary is included in structured memory', async () => {
        const prompter = Object.create(Prompter.prototype);
        prompter.agent = {
            name: 'bot',
            history: { memory: '' },
            memory_bank: new MemoryBank(),
            task_ledger: {
                summary() {
                    return 'Task: blocked/VERIFY mine 4 copper verified=0/4 blocker=mining_verification_failed next=!recoverDroppedItems';
                },
            },
        };

        const out = await prompter.replaceStrings('$STRUCTURED_MEMORY', []);

        assert.match(out, /Task: blocked\/VERIFY mine 4 copper verified=0\/4/);
        assert.match(out, /Structured memory:/);
    });

    test('session memory is not part of saving_memory prompts', async () => {
        const prompter = Object.create(Prompter.prototype);
        Object.assign(prompter, {
            agent: {
                name: 'bot',
                history: { memory: 'Text memory only.' },
                memory_bank: new MemoryBank(),
                session_memory: {
                    lastCommandResultCode: 'ERR_MISSING_HOME_CHEST',
                    lastFailureReason: 'missing_home_chest',
                },
                transcript: { record() {} },
            },
            profile: {
                saving_memory: "Old Memory: '$MEMORY'\n$TO_SUMMARIZE",
            },
            chat_model: {
                model_name: 'test',
                async sendRequest(_messages, prompt) {
                    return prompt;
                },
            },
            async checkCooldown() {},
            async _saveLog() {},
        });

        const prompt = await prompter.promptMemSaving([{ role: 'user', content: 'hello' }]);

        assert.match(prompt, /Text memory only/);
        assert.doesNotMatch(prompt, /ERR_MISSING_HOME_CHEST/);
        assert.doesNotMatch(prompt, /Current session/);
    });
});

describe('Prompter newAction planning', () => {
    test('uses chat model for planning and code model for coding', async () => {
        const events = [];
        const modelCalls = [];
        const prompter = Object.create(Prompter.prototype);
        Object.assign(prompter, {
            agent: {
                name: 'bot',
                transcript: {
                    record(event, data, source) {
                        events.push({ event, data, source });
                    }
                },
                history: { memory: '' },
                self_prompter: {
                    isStopped() {
                        return true;
                    }
                }
            },
            profile: {
                new_action_planning: 'Plan for $NAME',
                coding: 'Code for $NAME'
            },
            coding_examples: null,
            chat_model: {
                model_name: 'chat-model',
                async sendRequest() {
                    modelCalls.push('chat');
                    return '{"selected_sub_goal":"place floor"}';
                }
            },
            code_model: {
                model_name: 'code-model',
                async sendRequest() {
                    modelCalls.push('code');
                    return '```js\nawait skills.wait(bot, 1);\n```';
                }
            },
            awaiting_coding: false,
            async checkCooldown() {},
            async _saveLog() {}
        });

        const plan = await prompter.promptNewActionPlan([]);
        const code = await prompter.promptCoding([]);

        assert.equal(plan, '{"selected_sub_goal":"place floor"}');
        assert.ok(code.includes('await skills.wait'));
        assert.deepEqual(modelCalls, ['chat', 'code']);
        assert.ok(events.some(entry =>
            entry.event === 'model.request' &&
            entry.data.kind === 'new_action_plan' &&
            entry.data.model === 'chat-model'
        ));
        assert.ok(events.some(entry =>
            entry.event === 'model.request' &&
            entry.data.kind === 'coding' &&
            entry.data.model === 'code-model'
        ));
    });
});

describe('Prompter conversation staleness', () => {
    test('uses a sequence id instead of same-millisecond timestamps', async () => {
        const prompter = Object.create(Prompter.prototype);
        let releaseFirst;
        let markFirstStarted;
        const firstStarted = new Promise(resolve => {
            markFirstStarted = resolve;
        });
        let calls = 0;
        Object.assign(prompter, {
            agent: {
                name: 'bot',
                transcript: { record() {} },
            },
            profile: {
                conversing: 'Hello $NAME'
            },
            convo_examples: null,
            prompt_sequence: 0,
            chat_model: {
                model_name: 'test',
                async sendRequest() {
                    calls += 1;
                    if (calls === 1) {
                        markFirstStarted();
                        await new Promise(resolve => {
                            releaseFirst = resolve;
                        });
                        return 'old response';
                    }
                    return 'new response';
                }
            },
            async checkCooldown() {},
            async _saveLog() {}
        });

        const first = prompter.promptConvo([]);
        await firstStarted;
        const second = prompter.promptConvo([]);
        await new Promise(resolve => setTimeout(resolve, 10));
        releaseFirst();

        assert.equal(await second, 'new response');
        assert.equal(await first, '');
    });
});
