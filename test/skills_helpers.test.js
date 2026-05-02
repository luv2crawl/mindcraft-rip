import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import {
    _directionToVec,
    _computePathfindTimeout,
    _goalApproxDistance,
    _interpolateChunkWaypoint,
    _isStandingInBlockCell,
    _isPassableForCorridor,
    _isHazardousFluid,
    _countEligibleMiningPickaxes,
    _missingMiningSupplies,
    buildMiningPlanFromInventory,
    formatChestContents,
    getMiningHomeChestPosition,
    getNearestStoragePosition,
} from '../src/agent/library/skills.js';
import { objectiveResult, formatObjectiveResult } from '../src/agent/objectives/objective_results.js';
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

describe('_interpolateChunkWaypoint', () => {
    test('interpolates Y along long planar movement', () => {
        const waypoint = _interpolateChunkWaypoint(
            new Vec3(0, 70, 0),
            new Vec3(80, -50, 0),
            40,
        );

        assert.deepEqual({ x: waypoint.x, y: waypoint.y, z: waypoint.z }, { x: 40, y: 10, z: 0 });
    });
});

describe('_isPassableForCorridor', () => {
    test('air is passable', () => {
        assert.equal(_isPassableForCorridor({ name: 'air' }), true);
    });
    test('cave_air and void_air are passable (mining adjacent to caves)', () => {
        // Naturally generated cave openings carry cave_air; the previous check
        // rejected these and aborted the corridor with "blocked".
        assert.equal(_isPassableForCorridor({ name: 'cave_air' }), true);
        assert.equal(_isPassableForCorridor({ name: 'void_air' }), true);
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

describe('_isStandingInBlockCell', () => {
    test('requires the bot to actually occupy the target block cell', () => {
        assert.equal(_isStandingInBlockCell(new Vec3(10.5, 64, -3.5), 10, 64, -4), true);
        assert.equal(_isStandingInBlockCell(new Vec3(10.99, 64.1, -3.01), 10, 64, -4), true);
        assert.equal(_isStandingInBlockCell(new Vec3(9.99, 64, -3.5), 10, 64, -4), false);
        assert.equal(_isStandingInBlockCell(new Vec3(10.5, 65, -3.5), 10, 64, -4), false);
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

    test('storage lookup accepts chest-like containers and remembers the last one', () => {
        const chestPos = new Vec3(3, 64, 0);
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            findBlocks({ matching }) {
                return matching({ name: 'barrel', position: chestPos }) ? [chestPos] : [];
            },
            blockAt(pos) {
                if (pos.equals(chestPos)) return { name: 'barrel', position: chestPos };
                return { name: 'air', position: pos };
            },
        };

        assert.deepEqual(getNearestStoragePosition(bot, 16), {
            x: 3,
            y: 64,
            z: 0,
            source: 'nearby',
        });
        assert.deepEqual(bot.mindcraftLastChestPosition, {
            x: 3,
            y: 64,
            z: 0,
            name: 'barrel',
        });
    });

    test('home chest lookup falls back to last known storage position when scanning misses', () => {
        const chestPos = new Vec3(43, 63, -9);
        const bot = {
            entity: { position: new Vec3(43, 63, -8) },
            mindcraftLastChestPosition: { x: 43, y: 63, z: -9, name: 'chest' },
            findBlocks() {
                return [];
            },
            blockAt(pos) {
                if (pos.equals(chestPos)) return { name: 'chest', position: chestPos };
                return { name: 'air', position: pos };
            },
        };

        assert.deepEqual(getMiningHomeChestPosition(bot, null), {
            x: 43,
            y: 63,
            z: -9,
            source: 'last_known',
        });
    });

    test('diamond mining plan reports missing supplies before travel', () => {
        const plan = buildMiningPlanFromInventory('diamond', 10, {
            stone_pickaxe: 3,
            stick: 14,
            crafting_table: 1,
        }, { currentY: 64 });

        assert.equal(plan.ok, false);
        assert.equal(plan.reason, 'missing_supplies');
        assert.equal(plan.missing.iron_pickaxe, 3);
        assert.match(plan.recommendedCommands.join('\n'), /takeFromChest\("iron_pickaxe", 3\)/);
    });

    test('mining plan succeeds with sufficient spare tools and table', () => {
        const plan = buildMiningPlanFromInventory('iron', 32, {
            stone_pickaxe: 2,
            crafting_table: 1,
            torch: 32,
        }, { currentY: 64 });

        assert.equal(plan.ok, true);
        assert.equal(plan.reason, 'ready');
    });

    test('underground stone-tier mining plan requires torches', () => {
        const plan = buildMiningPlanFromInventory('iron', 16, {
            stone_pickaxe: 2,
            crafting_table: 1,
        }, { currentY: 64 });

        assert.equal(plan.ok, false);
        assert.equal(plan.reason, 'missing_supplies');
        assert.equal(plan.need.torch, 32);
        assert.equal(plan.missing.torch, 32);
    });

    test('mining plan treats craftable pickaxes as ready supplies', () => {
        const plan = buildMiningPlanFromInventory('diamond', 10, {
            iron_ingot: 9,
            stick: 6,
            crafting_table: 1,
            torch: 32,
        }, { currentY: 64 });

        assert.equal(plan.ok, true);
        assert.equal(plan.reason, 'ready');
        assert.equal(plan.have.craftable_iron_pickaxe, 3);
    });
});

describe('chest content formatting', () => {
    test('aggregates full chest contents by item type', () => {
        const formatted = formatChestContents([
            { name: 'raw_copper', count: 64 },
            { name: 'lapis_lazuli', count: 64 },
            { name: 'iron_pickaxe', count: 1 },
            { name: 'raw_copper', count: 38 },
            { name: 'raw_iron', count: 7 },
            { name: 'iron_pickaxe', count: 1 },
        ]);

        assert.match(formatted, /6 stacks across 4 item types/);
        assert.match(formatted, /raw_copper: 102 \(2 stacks\)/);
        assert.match(formatted, /iron_pickaxe: 2 \(2 stacks\)/);
        assert.match(formatted, /raw_iron: 7 \(1 stack\)/);
        assert.doesNotMatch(formatted, /64 raw_copper\n/);
    });
});

describe('formatObjectiveResult — model-facing failure shape', () => {
    test('failure with missing/have/recommended renders all sections', () => {
        const out = formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'missing_ingredients',
            message: 'Cannot craft stone_pickaxe: missing ingredients.',
            need: { cobblestone: 3, stick: 2 },
            have: { cobblestone: 2, stick: 14 },
            missing: { cobblestone: 1 },
            recommendedCommands: ['!collectBlocks("cobblestone", 1)'],
        }));
        assert.match(out, /^FAILED: missing_ingredients/);
        assert.match(out, /Cannot craft stone_pickaxe/);
        assert.match(out, /Need: cobblestone x3, stick x2/);
        assert.match(out, /Have: cobblestone x2, stick x14/);
        assert.match(out, /Missing: cobblestone x1/);
        assert.match(out, /Recommended: !collectBlocks\("cobblestone", 1\)/);
    });
    test('omits empty sections so trivial failures stay short', () => {
        const out = formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'no_chest_in_range',
            message: 'No chest within 16 blocks.',
            missing: { chest_within_16_blocks: 1 },
            recommendedCommands: ['!searchForBlock("chest", 64)'],
        }));
        assert.doesNotMatch(out, /\bNeed:/);
        assert.doesNotMatch(out, /\bHave:/);
        assert.match(out, /Missing: chest_within_16_blocks x1/);
        assert.match(out, /Recommended: !searchForBlock/);
    });
    test('chains multiple recommended commands with " then "', () => {
        const out = formatObjectiveResult(objectiveResult({
            ok: false,
            reason: 'no_chest_in_range',
            message: 'No chest within 16 blocks.',
            recommendedCommands: ['!goToCoordinates(10, 64, -3, 1)', '!setHomeChest'],
        }));
        assert.match(out, /Recommended: !goToCoordinates\(10, 64, -3, 1\) then !setHomeChest/);
    });
});
