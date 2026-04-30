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
            const history = Object.create(History.prototype);
            history.memory = 'old';
            history.agent = {
                transcript: {
                    record: (...args) => events.push(args)
                },
                prompter: {
                    promptMemSaving: async () => 'new memory'
                }
            };

            await history.summarizeMemories([{ role: 'user', content: 'hello' }]);
            assert.equal(history.memory, 'new memory');
            assert.equal(events[0][0], 'memory.summary.start');
            assert.equal(events[1][0], 'memory.summary.end');
            assert.equal(events[1][1].memory, 'new memory');
        } finally {
            setSettings({ memory_summary_timeout_ms: originalTimeout });
        }
    });
});
