import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import {
    _directionToVec,
    _computePathfindTimeout,
    _goalApproxDistance,
    _isPassableForCorridor,
    _isHazardousFluid,
    _countEligibleMiningPickaxes,
    _missingMiningSupplies,
    getMiningHomeChestPosition,
} from '../src/agent/library/skills.js';
import settings from '../settings.js';

describe('_directionToVec', () => {
    test('cardinal directions map to expected unit vectors', () => {
        assert.deepEqual(_directionToVec('north'), { x: 0, z: -1, label: 'north' });
        assert.deepEqual(_directionToVec('south'), { x: 0, z: 1,  label: 'south' });
        assert.deepEqual(_directionToVec('east'),  { x: 1, z: 0,  label: 'east'  });
        assert.deepEqual(_directionToVec('west'),  { x: -1, z: 0, label: 'west'  });
    });
    test('case-insensitive', () => {
        assert.deepEqual(_directionToVec('NORTH'), { x: 0, z: -1, label: 'north' });
        assert.deepEqual(_directionToVec('North'), { x: 0, z: -1, label: 'north' });
    });
    test('unknown / missing direction defaults to south', () => {
        assert.deepEqual(_directionToVec('up'),       { x: 0, z: 1, label: 'south' });
        assert.deepEqual(_directionToVec('garbage'),  { x: 0, z: 1, label: 'south' });
        assert.deepEqual(_directionToVec(undefined),  { x: 0, z: 1, label: 'south' });
        assert.deepEqual(_directionToVec(null),       { x: 0, z: 1, label: 'south' });
        assert.deepEqual(_directionToVec(''),         { x: 0, z: 1, label: 'south' });
    });
});

describe('_computePathfindTimeout', () => {
    function fakeBotAt(x, y, z) {
        return { entity: { position: new Vec3(x, y, z) } };
    }

    test('uses settings: base + per_block * distance, clamped to max', () => {
        const base = settings.pathfind_timeout_base_ms;
        const perBlock = settings.pathfind_timeout_per_block_ms;
        const max = settings.pathfind_timeout_max_ms;

        // Distance 0 → base
        assert.equal(_computePathfindTimeout(fakeBotAt(0, 0, 0), { x: 0, y: 0, z: 0 }), base);
        // Distance 10 → base + 10*per_block
        assert.equal(
            _computePathfindTimeout(fakeBotAt(0, 0, 0), { x: 10, y: 0, z: 0 }),
            base + 10 * perBlock,
        );
        // Distance large enough to clamp at max
        assert.equal(
            _computePathfindTimeout(fakeBotAt(0, 0, 0), { x: 10000, y: 0, z: 0 }),
            max,
        );
    });
    test('returns max for goals without xyz (e.g. GoalFollow)', () => {
        const max = settings.pathfind_timeout_max_ms;
        const bot = fakeBotAt(0, 0, 0);
        assert.equal(_computePathfindTimeout(bot, { entity: 'whatever' }), max);
        assert.equal(_computePathfindTimeout(bot, null), max);
        assert.equal(_computePathfindTimeout(bot, undefined), max);
    });
    test('never returns less than base, even for negative arithmetic', () => {
        // Distance 0 plus base — defensive sanity that the base floor holds
        const base = settings.pathfind_timeout_base_ms;
        assert.ok(_computePathfindTimeout(fakeBotAt(0, 0, 0), { x: 0, y: 0, z: 0 }) >= base);
    });
});

describe('_goalApproxDistance', () => {
    function fakeBotAt(x, y, z) {
        return { entity: { position: new Vec3(x, y, z) } };
    }

    test('returns straight-line distance when goal has xyz', () => {
        const bot = fakeBotAt(0, 0, 0);
        assert.equal(_goalApproxDistance(bot, { x: 3, y: 0, z: 4 }), 5);
        assert.equal(_goalApproxDistance(bot, { x: 0, y: 0, z: 0 }), 0);
    });
    test('returns null when goal lacks coordinates', () => {
        const bot = fakeBotAt(0, 0, 0);
        assert.equal(_goalApproxDistance(bot, {}), null);
        assert.equal(_goalApproxDistance(bot, { entity: {} }), null);
        assert.equal(_goalApproxDistance(bot, { x: 1 }), null); // partial
        assert.equal(_goalApproxDistance(bot, null), null);
        assert.equal(_goalApproxDistance(bot, undefined), null);
    });
    test('rejects goals where any coord is non-numeric', () => {
        const bot = fakeBotAt(0, 0, 0);
        assert.equal(_goalApproxDistance(bot, { x: 1, y: 2, z: 'foo' }), null);
    });
});

describe('_isPassableForCorridor', () => {
    test('air is passable', () => {
        assert.equal(_isPassableForCorridor({ name: 'air' }), true);
    });
    test('null/undefined block (unloaded chunk) is passable', () => {
        assert.equal(_isPassableForCorridor(null), true);
        assert.equal(_isPassableForCorridor(undefined), true);
    });
    test('solid blocks are not passable', () => {
        assert.equal(_isPassableForCorridor({ name: 'stone' }), false);
        assert.equal(_isPassableForCorridor({ name: 'deepslate' }), false);
        assert.equal(_isPassableForCorridor({ name: 'bedrock' }), false);
    });
    test('water and lava are NOT considered passable for the corridor', () => {
        // Critical: branchMineStep should bail before walking into them.
        assert.equal(_isPassableForCorridor({ name: 'water' }), false);
        assert.equal(_isPassableForCorridor({ name: 'lava' }), false);
    });
});

describe('_isHazardousFluid', () => {
    test('lava and water (still + flowing) are hazardous', () => {
        assert.equal(_isHazardousFluid({ name: 'lava' }), true);
        assert.equal(_isHazardousFluid({ name: 'water' }), true);
        assert.equal(_isHazardousFluid({ name: 'flowing_lava' }), true);
        assert.equal(_isHazardousFluid({ name: 'flowing_water' }), true);
    });
    test('air, stone, etc. are not hazardous', () => {
        assert.equal(_isHazardousFluid({ name: 'air' }), false);
        assert.equal(_isHazardousFluid({ name: 'stone' }), false);
        assert.equal(_isHazardousFluid({ name: 'iron_ore' }), false);
    });
    test('null block is not hazardous', () => {
        assert.equal(_isHazardousFluid(null), false);
        assert.equal(_isHazardousFluid(undefined), false);
    });
});

describe('mining supply helpers', () => {
    test('counts only pickaxes that can mine the requested tier', () => {
        const inventory = {
            wooden_pickaxe: 2,
            stone_pickaxe: 1,
            iron_pickaxe: 2,
            diamond_pickaxe: 1,
        };
        assert.equal(_countEligibleMiningPickaxes(inventory, 'stone'), 4);
        assert.equal(_countEligibleMiningPickaxes(inventory, 'iron'), 3);
        assert.equal(_countEligibleMiningPickaxes(inventory, 'diamond'), 1);
    });

    test('diamond-tier ore supply asks for iron ingots and sticks when iron picks can be crafted', () => {
        assert.deepEqual(
            _missingMiningSupplies({ iron_pickaxe: 1, iron_ingot: 3, stick: 2, crafting_table: 1 }, 'iron', 3),
            { iron_ingot: 3, stick: 2 },
        );
    });

    test('sufficient spare iron pickaxes only needs a crafting table when missing', () => {
        assert.deepEqual(
            _missingMiningSupplies({ iron_pickaxe: 3, torch: 12 }, 'iron', 3),
            { crafting_table: 1 },
        );
    });

    test('stone-tier runs request spare stone pickaxes, not impossible stone ingots', () => {
        assert.deepEqual(
            _missingMiningSupplies({ stone_pickaxe: 1, crafting_table: 1 }, 'stone', 2),
            { cobblestone: 3, stick: 2 },
        );
    });

    test('stone-tier runs count cobblestone and sticks as craftable spare pickaxes', () => {
        assert.deepEqual(
            _missingMiningSupplies({ stone_pickaxe: 1, cobblestone: 3, stick: 2, crafting_table: 1 }, 'stone', 2),
            {},
        );
    });

    test('home chest lookup prefers saved memory over a nearby chest', () => {
        const bot = {};
        const memoryBank = { recallPlace: name => name === 'home_chest' ? [70, 64, -4] : null };
        assert.deepEqual(getMiningHomeChestPosition(bot, memoryBank), {
            x: 70,
            y: 64,
            z: -4,
            source: 'memory',
        });
    });
});
