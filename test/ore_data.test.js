import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    getKnownOres,
    getOreInfo,
    getOreBlockNames,
    getRequiredPickaxe,
    getBestY,
    botHasRequiredPickaxe,
} from '../src/agent/library/ore_data.js';

function fakeBot(items) {
    return { inventory: { items: () => items } };
}

describe('getKnownOres', () => {
    test('returns the full set from the data file', () => {
        const ores = getKnownOres();
        assert.equal(ores.length, 11);
        for (const name of ['coal', 'iron', 'diamond', 'lapis_lazuli', 'ancient_debris', 'nether_quartz']) {
            assert.ok(ores.includes(name), `expected "${name}" in known ores`);
        }
    });
});

describe('getOreInfo: name normalization', () => {
    test('lowercase simple name', () => {
        assert.equal(getOreInfo('iron').key, 'iron');
    });
    test('"_ore" suffix is stripped', () => {
        assert.equal(getOreInfo('iron_ore').key, 'iron');
    });
    test('capitalized name from JSON', () => {
        assert.equal(getOreInfo('Iron').key, 'iron');
    });
    test('"deepslate_" prefix is stripped', () => {
        assert.equal(getOreInfo('deepslate_iron_ore').key, 'iron');
    });
    test('multi-word names handled', () => {
        assert.equal(getOreInfo('Lapis Lazuli').key, 'lapis_lazuli');
        assert.equal(getOreInfo('Nether Quartz').key, 'nether_quartz');
        assert.equal(getOreInfo('nether quartz').key, 'nether_quartz');
    });
    test('"ancient_debris" special case (no _ore suffix in minecraft)', () => {
        assert.equal(getOreInfo('ancient_debris').key, 'ancient_debris');
        assert.equal(getOreInfo('Ancient Debris').key, 'ancient_debris');
    });
    test('whitespace tolerated', () => {
        assert.equal(getOreInfo('  iron  ').key, 'iron');
    });
    test('unknown ore returns null', () => {
        assert.equal(getOreInfo('mythril'), null);
        assert.equal(getOreInfo(''), null);
        assert.equal(getOreInfo(null), null);
        assert.equal(getOreInfo(undefined), null);
    });
});

describe('getOreInfo: payload', () => {
    test('iron has expected fields', () => {
        const i = getOreInfo('iron');
        assert.equal(i.display, 'Iron');
        assert.equal(i.min_pickaxe, 'stone');
        assert.deepEqual(i.best_y_levels, [16, 232]);
        assert.equal(i.dimension, 'overworld');
    });
    test('ancient_debris is in nether dimension', () => {
        assert.equal(getOreInfo('ancient_debris').dimension, 'nether');
    });
    test('block_names embedded for matching', () => {
        assert.deepEqual(getOreInfo('iron').block_names, ['iron_ore', 'deepslate_iron_ore']);
    });
});

describe('getOreBlockNames', () => {
    test('returns stone + deepslate variants for overworld ores', () => {
        assert.deepEqual(getOreBlockNames('iron'), ['iron_ore', 'deepslate_iron_ore']);
        assert.deepEqual(getOreBlockNames('coal'), ['coal_ore', 'deepslate_coal_ore']);
        assert.deepEqual(getOreBlockNames('diamond'), ['diamond_ore', 'deepslate_diamond_ore']);
    });
    test('lapis uses minecraft\'s short deepslate name (lapis_ore, not lapis_lazuli_ore)', () => {
        assert.deepEqual(getOreBlockNames('lapis_lazuli'), ['lapis_ore', 'deepslate_lapis_ore']);
    });
    test('nether ores have no deepslate variant', () => {
        assert.deepEqual(getOreBlockNames('nether_quartz'), ['nether_quartz_ore']);
        assert.deepEqual(getOreBlockNames('nether_gold'), ['nether_gold_ore']);
    });
    test('ancient_debris is its own block name', () => {
        assert.deepEqual(getOreBlockNames('ancient_debris'), ['ancient_debris']);
    });
    test('unknown ore returns empty array', () => {
        assert.deepEqual(getOreBlockNames('mythril'), []);
    });
    test('returned array is a copy, not the internal one', () => {
        const a = getOreBlockNames('iron');
        a.push('mutated');
        assert.deepEqual(getOreBlockNames('iron'), ['iron_ore', 'deepslate_iron_ore']);
    });
});

describe('getRequiredPickaxe', () => {
    test('matches the source data tiers', () => {
        assert.equal(getRequiredPickaxe('coal'), 'wooden');
        assert.equal(getRequiredPickaxe('copper'), 'stone');
        assert.equal(getRequiredPickaxe('iron'), 'stone');
        assert.equal(getRequiredPickaxe('lapis_lazuli'), 'stone');
        assert.equal(getRequiredPickaxe('gold'), 'iron');
        assert.equal(getRequiredPickaxe('redstone'), 'iron');
        assert.equal(getRequiredPickaxe('diamond'), 'iron');
        assert.equal(getRequiredPickaxe('emerald'), 'iron');
        assert.equal(getRequiredPickaxe('ancient_debris'), 'diamond');
    });
    test('unknown ore returns null', () => {
        assert.equal(getRequiredPickaxe('mythril'), null);
    });
});

describe('getBestY', () => {
    test('picks the closer of multiple candidates', () => {
        // iron: [16, 232]
        assert.equal(getBestY('iron', 70), 16);   // 70-16=54 < 232-70=162
        assert.equal(getBestY('iron', 200), 232); // 200-16=184 > 232-200=32
        assert.equal(getBestY('iron', 124), 16);  // 124-16=108 < 232-124=108 — tie, first wins
        assert.equal(getBestY('iron', 125), 232); // 125-16=109 > 232-125=107
    });
    test('handles single-element best-Y list', () => {
        // copper: [48]
        assert.equal(getBestY('copper', 0), 48);
        assert.equal(getBestY('copper', 100), 48);
        assert.equal(getBestY('copper', -50), 48);
    });
    test('returns first when current_y is missing or non-numeric', () => {
        assert.equal(getBestY('iron'), 16);
        assert.equal(getBestY('iron', null), 16);
        assert.equal(getBestY('iron', 'top'), 16);
    });
    test('returns null for unknown ore', () => {
        assert.equal(getBestY('mythril', 70), null);
    });
    test('redstone deepest tier (best at -59)', () => {
        assert.equal(getBestY('redstone', 70), -59);
    });
});

describe('botHasRequiredPickaxe', () => {
    test('approves when bot has the exact required tier', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'stone_pickaxe', count: 1 }]), 'iron');
        assert.equal(r.ok, true);
        assert.equal(r.has, 'stone_pickaxe');
        assert.equal(r.needs, 'stone');
        assert.equal(r.reason, 'ok');
    });
    test('approves when bot has a higher tier than needed', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'diamond_pickaxe', count: 1 }]), 'iron');
        assert.equal(r.ok, true);
        assert.equal(r.has, 'diamond_pickaxe');
    });
    test('rejects with tier_too_low when bot has a lower tier', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'wooden_pickaxe', count: 1 }]), 'iron');
        assert.equal(r.ok, false);
        assert.equal(r.has, 'wooden_pickaxe');
        assert.equal(r.needs, 'stone');
        assert.equal(r.reason, 'tier_too_low');
    });
    test('rejects with no_pickaxe when bot has none', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'wooden_sword', count: 1 }]), 'iron');
        assert.equal(r.ok, false);
        assert.equal(r.has, null);
        assert.equal(r.reason, 'no_pickaxe');
    });
    test('treats golden_pickaxe as wooden tier (matches harvest level)', () => {
        // golden cannot mine iron-tier blocks despite being a "pickaxe" — it's harvest-level 1.
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'golden_pickaxe', count: 1 }]), 'iron');
        assert.equal(r.ok, false);
        assert.equal(r.has, 'golden_pickaxe');
        assert.equal(r.reason, 'tier_too_low');
    });
    test('approves netherite for any tier', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'netherite_pickaxe', count: 1 }]), 'ancient_debris');
        assert.equal(r.ok, true);
    });
    test('picks the highest tier when bot has multiple pickaxes', () => {
        const r = botHasRequiredPickaxe(fakeBot([
            { name: 'wooden_pickaxe', count: 1 },
            { name: 'iron_pickaxe', count: 1 },
            { name: 'stone_pickaxe', count: 1 },
        ]), 'diamond');
        assert.equal(r.ok, true);
        assert.equal(r.has, 'iron_pickaxe');
    });
    test('handles unknown ore gracefully', () => {
        const r = botHasRequiredPickaxe(fakeBot([{ name: 'iron_pickaxe', count: 1 }]), 'mythril');
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'unknown_ore');
    });
});
