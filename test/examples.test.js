import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { Examples, exampleIntentText, latestIntentText, normalizeIntentText } from '../src/utils/examples.js';
import { wordOverlapScore } from '../src/utils/text.js';

const defaultProfile = JSON.parse(readFileSync(new URL('../profiles/defaults/_default.json', import.meta.url), 'utf8'));

function outputs(examples) {
    return examples
        .flatMap(example => example.filter(turn => turn.role === 'assistant'))
        .map(turn => turn.content)
        .join('\n');
}

describe('example intent normalization', () => {
    test('strips addressed-bot filler without removing mining terms', () => {
        const normalized = normalizeIntentText('viral_loop: hi deepseek, can you mine some iron ore please?');

        assert.equal(normalized, 'mine some iron ore');
        assert.ok(wordOverlapScore(normalized, 'mine iron ore') > 0.8);
    });

    test('mining requests score above social examples', () => {
        const miningIntent = 'mine some iron ore';
        const socialIntent = 'say hi to john_goodman';

        assert.ok(
            wordOverlapScore('mine iron ore', miningIntent) > wordOverlapScore('mine iron ore', socialIntent)
        );
    });

    test('system examples are fallback intents, user examples are preferred on ties', async () => {
        const examples = new Examples(null, 1);
        await examples.load([
            [
                { role: 'system', content: 'mine iron ore' },
                { role: 'assistant', content: '!planMiningRun("iron", 16)' }
            ],
            [
                { role: 'user', content: 'miner_32: mine iron ore' },
                { role: 'assistant', content: '!mineOre("iron", 16)' }
            ]
        ]);

        const selected = await examples.getRelevant([{ role: 'user', content: 'viral_loop: mine iron ore' }]);

        assert.equal(exampleIntentText(selected[0]), 'mine iron ore');
        assert.match(outputs(selected), /!mineOre\("iron", 16\)/);
    });

    test('latest intent prefers the newest user turn over old context', () => {
        const intent = latestIntentText([
            { role: 'user', content: 'john_goodman: say hi' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'system', content: 'Code output: done' },
            { role: 'user', content: 'viral_loop: can you mine some iron ore please?' }
        ]);

        assert.equal(intent, 'mine some iron ore');
    });
});

describe('example selection fallback', () => {
    test('mining request selects mining examples without embeddings', async () => {
        const examples = new Examples(null, 2);
        await examples.load(defaultProfile.conversation_examples);

        const selected = await examples.getRelevant([
            { role: 'user', content: 'viral_loop: hi deepseek, can you mine some iron ore please?' }
        ]);

        assert.match(outputs(selected), /!planMiningRun\("iron", 16\)/);
        assert.doesNotMatch(outputs(selected), /!startConversation\("john_goodman"/);
    });

    test('social request still selects greeting or conversation examples', async () => {
        const examples = new Examples(null, 2);
        await examples.load(defaultProfile.conversation_examples);

        const selected = await examples.getRelevant([
            { role: 'user', content: 'viral_loop: say hi to john_goodman' }
        ]);

        assert.match(outputs(selected), /john_goodman|Hey John|startConversation/);
    });

    test('old repeated history does not override the latest request', async () => {
        const examples = new Examples(null, 1);
        await examples.load(defaultProfile.conversation_examples);

        const selected = await examples.getRelevant([
            { role: 'user', content: 'john_goodman: say hi' },
            { role: 'assistant', content: 'Hey John' },
            { role: 'user', content: 'john_goodman: say hi again' },
            { role: 'assistant', content: 'Hey again' },
            { role: 'user', content: 'viral_loop: mine diamonds' }
        ]);

        assert.match(outputs(selected), /!planMiningRun\("diamond", 10\)/);
    });

    test('getRelevant does not mutate original example order', async () => {
        const first = [
            { role: 'user', content: 'alice: say hi' },
            { role: 'assistant', content: 'Hi.' }
        ];
        const second = [
            { role: 'user', content: 'bob: mine diamonds' },
            { role: 'assistant', content: '!planMiningRun("diamond", 10)' }
        ];
        const examples = new Examples(null, 1);
        await examples.load([first, second]);

        await examples.getRelevant([{ role: 'user', content: 'bob: mine diamonds' }]);

        assert.equal(examples.examples[0], first);
        assert.equal(examples.examples[1], second);
    });
});

describe('example selection embedding failures', () => {
    test('query embedding failure falls back without escaping createExampleMessage', async () => {
        const model = {
            fail: false,
            async embed(text) {
                if (this.fail)
                    throw new Error(`query failed: ${text}`);
                return [1, 0, 0];
            }
        };
        const examples = new Examples(model, 1);
        await examples.load(defaultProfile.conversation_examples);
        model.fail = true;

        const message = await examples.createExampleMessage([
            { role: 'user', content: 'viral_loop: mine some iron ore' }
        ]);

        assert.match(message, /!planMiningRun\("iron", 16\)/);
    });

    test('missing example embeddings use fallback scoring instead of NaN', async () => {
        const model = {
            async embed(text) {
                return text.includes('diamond') ? [0, 1] : [1, 0];
            }
        };
        const examples = new Examples(model, 1);
        await examples.load([
            [
                { role: 'user', content: 'alice: say hi' },
                { role: 'assistant', content: 'Hi.' }
            ],
            [
                { role: 'user', content: 'bob: mine diamonds' },
                { role: 'assistant', content: '!planMiningRun("diamond", 10)' }
            ]
        ]);
        examples.embeddings = {};

        const selected = await examples.getRelevant([{ role: 'user', content: 'bob: mine diamonds' }]);

        assert.match(outputs(selected), /!planMiningRun\("diamond", 10\)/);
    });

    test('logs selected intent and assistant output', async () => {
        const examples = new Examples(null, 1);
        await examples.load([
            [
                { role: 'user', content: 'bob: mine diamonds' },
                { role: 'assistant', content: '!planMiningRun("diamond", 10)' }
            ]
        ]);
        const originalLog = console.log;
        const logs = [];
        console.log = (...args) => logs.push(args.join(' '));
        try {
            await examples.createExampleMessage([{ role: 'user', content: 'bob: mine diamonds' }]);
        } finally {
            console.log = originalLog;
        }

        assert.ok(logs.some(line => line.includes('Example selected: intent="mine diamonds" output="!planMiningRun("diamond", 10)"')));
    });
});
