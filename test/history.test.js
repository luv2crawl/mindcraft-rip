import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/agent/history.js';
import settings, { setSettings } from '../src/agent/settings.js';

describe('History memory summarization', () => {
    test('keeps existing memory when summarization times out', async () => {
        const originalTimeout = settings.memory_summary_timeout_ms;
        settings.memory_summary_timeout_ms = 5;
        try {
            const events = [];
            const history = Object.create(History.prototype);
            history.memory = 'keep this';
            history.agent = {
                transcript: {
                    record: (...args) => events.push(args)
                },
                prompter: {
                    promptMemSaving: () => new Promise(() => {})
                }
            };

            await history.summarizeMemories([{ role: 'user', content: 'hello' }]);
            assert.equal(history.memory, 'keep this');
            assert.equal(events[0][0], 'memory.summary.start');
            assert.equal(events[1][0], 'memory.summary.failure');
        } finally {
            setSettings({ memory_summary_timeout_ms: originalTimeout });
        }
    });

    test('updates memory when summarization completes in time', async () => {
        const originalTimeout = settings.memory_summary_timeout_ms;
        settings.memory_summary_timeout_ms = 1000;
        try {
            const events = [];
            let summarizedTurns = null;
            const history = Object.create(History.prototype);
            history.memory = 'old';
            history.agent = {
                transcript: {
                    record: (...args) => events.push(args)
                },
                prompter: {
                    promptMemSaving: async turns => {
                        summarizedTurns = turns;
                        return 'new memory';
                    }
                }
            };

            await history.summarizeMemories([
                { role: 'system', content: '(AUTO MESSAGE)Your previous action was interrupted.' },
                { role: 'system', content: 'Action output:\nPlaced torch.' },
                { role: 'user', content: 'player: remember base is north of spawn' }
            ]);
            assert.equal(history.memory, 'new memory');
            assert.deepEqual(summarizedTurns, [
                { role: 'user', content: 'player: remember base is north of spawn' }
            ]);
            assert.equal(events[0][0], 'memory.summary.start');
            assert.equal(events[0][1].filtered_turn_count, 1);
            assert.equal(events[1][0], 'memory.summary.end');
            assert.equal(events[1][1].memory, 'new memory');
        } finally {
            setSettings({ memory_summary_timeout_ms: originalTimeout });
        }
    });

    test('keeps truncated memory within the documented 500 character cap', async () => {
        const history = Object.create(History.prototype);
        history.memory = '';
        history.agent = {
            transcript: {
                record() {}
            },
            prompter: {
                promptMemSaving: async () => 'x'.repeat(600)
            }
        };

        await history.summarizeMemories([{ role: 'user', content: 'remember this' }]);

        assert.equal(history.memory.length, 500);
        assert.match(history.memory, /Memory truncated to 500 chars/);
    });

    test('filters long action output summaries from durable memory', async () => {
        const history = Object.create(History.prototype);

        assert.equal(history._isLowValueMemoryTurn({
            role: 'system',
            content: 'Action output:\nOutput is very long (1000 chars) and has been shortened.'
        }), true);
    });

    test('skips summarization when a chunk only contains transient action noise', async () => {
        const events = [];
        let calls = 0;
        const history = Object.create(History.prototype);
        history.memory = 'keep durable memory';
        history.agent = {
            transcript: {
                record: (...args) => events.push(args)
            },
            prompter: {
                promptMemSaving: async () => {
                    calls++;
                    return 'bad memory';
                }
            }
        };

        const ok = await history.summarizeMemories([
            { role: 'system', content: '(AUTO MESSAGE)Your previous action was interrupted by self_preservation.' },
            { role: 'system', content: 'Action output:\nPlaced torch at (1, 2, 3).' },
            { role: 'assistant', content: 'Item collecting interrupted. !stop' }
        ]);

        assert.equal(ok, true);
        assert.equal(calls, 0);
        assert.equal(history.memory, 'keep durable memory');
        assert.ok(events.some(event => event[0] === 'memory.summary.skipped'));
    });

    test('requeues evicted turns when summarization fails', async () => {
        const originalTimeout = settings.memory_summary_timeout_ms;
        settings.memory_summary_timeout_ms = 5;
        try {
            const events = [];
            const history = Object.create(History.prototype);
            history.memory = 'old memory';
            history.turns = [];
            history.max_messages = 3;
            history.summary_chunk_size = 2;
            history.pending_summary = Promise.resolve();
            history.summary_in_progress = false;
            history.appendFullHistory = async () => {};
            history.name = 'bot';
            history.agent = {
                name: 'bot',
                transcript: {
                    record: (...args) => events.push(args)
                },
                prompter: {
                    promptMemSaving: () => Promise.reject(new Error('nope'))
                }
            };

            await history.add('player', 'one');
            await history.add('player', 'two');
            await history.add('player', 'three');
            await history.pending_summary;

            assert.equal(history.memory, 'old memory');
            assert.equal(history.turns.length, 3);
            assert.deepEqual(history.turns.map(turn => turn.content), [
                'player: one',
                'player: two',
                'player: three'
            ]);
            assert.ok(events.some(event => event[0] === 'memory.summary.requeued'));
        } finally {
            setSettings({ memory_summary_timeout_ms: originalTimeout });
        }
    });
});
