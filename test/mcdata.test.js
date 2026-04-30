import test from 'node:test';
import assert from 'node:assert/strict';

import { isHostile } from '../src/utils/mcdata.js';

test('isHostile uses an explicit hostile mob allowlist', () => {
    assert.equal(isHostile({ name: 'zombie', type: 'mob' }), true);
    assert.equal(isHostile({ name: 'creeper', type: 'mob' }), true);
    assert.equal(isHostile({ name: 'cod', type: 'mob' }), false);
    assert.equal(isHostile({ name: 'squid', type: 'mob' }), false);
    assert.equal(isHostile({ name: 'cow', type: 'mob' }), false);
    assert.equal(isHostile({ name: 'iron_golem', type: 'mob' }), false);
});
