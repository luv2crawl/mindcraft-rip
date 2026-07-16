import test from 'node:test';
import assert from 'node:assert/strict';

import { ObjectiveStack } from '../src/agent/objectives/objective_stack.js';
import { objectiveResult, formatObjectiveResult } from '../src/agent/objectives/objective_results.js';
import { buildVerifiedMiningResult, runMiningObjective } from '../src/agent/objectives/mining_objective.js';

test('ObjectiveStack pushes, peeks, updates, pops, and clears frames', () => {
    const events = [];
    const stack = new ObjectiveStack({ transcript: { record: (...args) => events.push(args) } });

    const parent = stack.push({ type: 'mine_ore', args: { ore: 'diamond' }, state: 'PLAN' });
    const child = stack.push({ type: 'craft_toolchain_for', args: { tool: 'iron_pickaxe' }, state: 'CHECK' });

    assert.equal(stack.peek().id, child.id);
    stack.updateTop({ state: 'DONE', status: 'completed' });
    assert.equal(stack.peek().state, 'DONE');

    const result = objectiveResult({ ok: true, reason: 'done' });
    const popped = stack.pop(result);
    assert.equal(popped.id, child.id);
    assert.equal(stack.peek().id, parent.id);

    assert.match(stack.getSummary(), /mine_ore/);
    assert.equal(stack.clear(), 1);
    assert.equal(stack.getSummary(), 'Objective stack: empty.');
    assert.ok(events.length >= 4);
});

test('formatObjectiveResult emits machine-useful failure fields', () => {
    const formatted = formatObjectiveResult(objectiveResult({
        ok: false,
        reason: 'missing_supplies',
        message: 'Cannot craft stone_pickaxe.',
        need: { cobblestone: 3, stick: 2 },
        have: { cobblestone: 2, stick: 14 },
        missing: { cobblestone: 1 },
        recommendedCommands: ['!collectBlocks("cobblestone", 1)'],
    }));

    assert.match(formatted, /FAILED: missing_supplies/);
    assert.match(formatted, /Missing: cobblestone x1/);
    assert.match(formatted, /Recommended: !collectBlocks\("cobblestone", 1\)/);
});

test('formatObjectiveResult emits scalar result data', () => {
    const formatted = formatObjectiveResult(objectiveResult({
        ok: false,
        reason: 'partial',
        message: 'Mining objective incomplete for iron: mined 0/30.',
        data: {
            mined: 0,
            target: 30,
            exitReason: 'max steps (500) reached',
            nested: { ignored: true },
        },
    }));

    assert.match(formatted, /FAILED: partial/);
    assert.match(formatted, /Data: mined: 0, target: 30, exitReason: max steps \(500\) reached/);
    assert.doesNotMatch(formatted, /nested/);
});

test('ObjectiveStack.pop preserves explicit terminal status', () => {
    const stack = new ObjectiveStack({ transcript: { record() {} } });
    stack.push({ type: 'mine_ore', status: 'running' });
    stack.updateTop({ status: 'failed' });

    const popped = stack.pop(objectiveResult({ ok: true, reason: 'done' }));

    assert.equal(popped.status, 'failed');
});

test('ObjectiveStack.pop treats legacy failure results as failed', () => {
    const stack = new ObjectiveStack({ transcript: { record() {} } });

    stack.push({ type: 'mine_ore', status: 'running' });
    assert.equal(stack.pop('FAILED: no_path\nCould not reach target.').status, 'failed');

    stack.push({ type: 'mine_ore', status: 'running' });
    assert.equal(stack.pop(null).status, 'failed');
});

test('runMiningObjective pops frame on plan failure', async () => {
    const stack = new ObjectiveStack({ transcript: { record() {} } });
    const agent = {
        bot: null,
        objectives: stack,
        transcript: { record() {} },
    };

    const result = await runMiningObjective(agent, 'unobtainium', 1);

    assert.match(result, /FAILED: no_bot/);
    assert.equal(stack.frames.length, 0);
});

test('buildVerifiedMiningResult rejects mined counts without inventory or deposit evidence', () => {
    const agent = {
        bot: {
            inventory: {
                items() {
                    return [];
                },
            },
        },
    };

    const result = buildVerifiedMiningResult(agent, 'copper', { ok: true, mined: 4, target: 4, data: {} }, 4);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'mining_verification_failed');
    assert.equal(result.data.verified, 0);
    assert.deepEqual(result.recommendedCommands, ['!recoverDroppedItems', '!taskStatus']);
});

test('buildVerifiedMiningResult accepts deposited mining evidence', () => {
    const agent = {
        bot: {
            inventory: {
                items() {
                    return [];
                },
            },
        },
    };

    const result = buildVerifiedMiningResult(agent, 'copper', {
        ok: true,
        mined: 4,
        target: 4,
        data: { depositedCounts: { raw_copper: 4 } },
    }, 4);

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'done');
    assert.equal(result.data.verified, 4);
    assert.equal(result.data.depositedVerified, 4);
});
