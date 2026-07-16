import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMindServerSettings } from '../src/mindcraft/mindserver.js';

function baseSettings() {
    return {
        profile: { name: 'validator_bot' },
    };
}

describe('MindServer settings validation', () => {
    test('fills defaults and drops unknown settings', () => {
        const result = normalizeMindServerSettings({
            ...baseSettings(),
            unknown_setting: true,
        });

        assert.equal(result.ok, true);
        assert.equal(result.settings.profile.name, 'validator_bot');
        assert.equal(result.settings.host, '127.0.0.1');
        assert.equal(result.settings.unknown_setting, undefined);
    });

    test('rejects invalid setting types', () => {
        const result = normalizeMindServerSettings({
            ...baseSettings(),
            blocked_actions: '!stop',
        });

        assert.equal(result.ok, false);
        assert.match(result.error, /blocked_actions.*array/);
    });

    test('rejects invalid option values', () => {
        const result = normalizeMindServerSettings({
            ...baseSettings(),
            base_profile: 'not_a_profile',
        });

        assert.equal(result.ok, false);
        assert.match(result.error, /base_profile.*one of/);
    });
});
