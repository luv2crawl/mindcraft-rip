import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GPT } from '../src/models/gpt.js';

describe('GPT adapter formatting', () => {
    test('responses input does not mutate turns or append stop markers', async () => {
        const calls = [];
        const model = Object.create(GPT.prototype);
        Object.assign(model, {
            model_name: 'gpt-5.4',
            params: {},
            url: null,
            openai: {
                responses: {
                    async create(pack) {
                        calls.push(pack);
                        return { output_text: 'done***ignored' };
                    },
                },
            },
        });
        const turns = [
            { role: 'system', content: 'OK: command result' },
            { role: 'user', content: 'go mine some copper and coal' },
        ];
        const before = JSON.stringify(turns);

        const response = await model.sendRequest(turns, 'system instructions');

        assert.equal(response, 'done');
        assert.equal(JSON.stringify(turns), before);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].instructions, 'system instructions');
        assert.equal(calls[0].input.filter(msg => msg.content.includes('go mine some copper and coal')).length, 1);
        assert.equal(calls[0].input.some(msg => msg.content.includes('***')), false);
    });
});
