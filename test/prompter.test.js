import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Prompter } from '../src/models/prompter.js';

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
});
