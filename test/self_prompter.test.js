import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SelfPrompter } from '../src/agent/self_prompter.js';

describe('SelfPrompter interruption', () => {
    test('stop requests interrupt even after state becomes stopped', async () => {
        const prompter = new SelfPrompter({
            actions: {
                async stop() {}
            },
            isIdle: () => true,
            transcript: { record() {} },
        });
        prompter.state = 1;
        prompter.loop_active = true;

        await prompter.stop(false);

        assert.equal(prompter.isStopped(), true);
        assert.equal(prompter.interrupt, true);
        assert.equal(prompter.shouldInterrupt(true), true);
        assert.equal(prompter.shouldInterrupt(false), false);
    });

    test('stopLoop can wait on an already-requested interrupt', async () => {
        const prompter = new SelfPrompter({
            actions: {
                async stop() {}
            },
            isIdle: () => true,
            transcript: { record() {} },
        });
        prompter.loop_active = true;
        prompter.interrupt = true;

        const waited = prompter.stopLoop();
        setTimeout(() => {
            prompter.loop_active = false;
        }, 5);
        await waited;

        assert.equal(prompter.interrupt, false);
    });
});
