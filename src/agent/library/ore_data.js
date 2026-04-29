import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const _raw = JSON.parse(readFileSync(path.join(__dirname, 'minecraft_ores.json'), 'utf8'));

// Map normalized ore key (e.g. "iron", "lapis_lazuli", "ancient_debris") -> the ore record
// from the source JSON, plus the corresponding minecraft block ids.
const ORE_BLOCKS = {
    coal:           ['coal_ore', 'deepslate_coal_ore'],
    copper:         ['copper_ore', 'deepslate_copper_ore'],
    iron:           ['iron_ore', 'deepslate_iron_ore'],
    lapis_lazuli:   ['lapis_ore', 'deepslate_lapis_ore'],
    gold:           ['gold_ore', 'deepslate_gold_ore'],
    redstone:       ['redstone_ore', 'deepslate_redstone_ore'],
    diamond:        ['diamond_ore', 'deepslate_diamond_ore'],
    emerald:        ['emerald_ore', 'deepslate_emerald_ore'],
    nether_quartz:  ['nether_quartz_ore'],
    nether_gold:    ['nether_gold_ore'],
    ancient_debris: ['ancient_debris'],
};

const PICKAXE_RANK = {
    wooden_pickaxe: 1,
    golden_pickaxe: 1, // matches wooden harvest level
    stone_pickaxe: 2,
    iron_pickaxe: 3,
    diamond_pickaxe: 4,
    netherite_pickaxe: 5,
};

const TIER_RANK = {
    wooden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
};

function normalizeOreKey(name) {
    if (!name) return null;
    let s = String(name).toLowerCase().trim().replace(/\s+/g, '_');
    if (s === 'ancient_debris') return s; // special case, no _ore suffix
    s = s.replace(/^deepslate_/, '');
    s = s.replace(/_ore$/, '');
    return s;
}

const ORE_INDEX = {};
for (const ore of [..._raw.overworld_ores, ..._raw.nether_ores]) {
    const key = normalizeOreKey(ore.ore);
    ORE_INDEX[key] = {
        key,
        display: ore.ore,
        color: ore.color,
        y_range: ore.y_range,
        best_y_levels: ore.best_y_levels,
        min_pickaxe: ore.min_pickaxe,
        uses: ore.uses,
        notes: ore.notes,
        block_names: ORE_BLOCKS[key] || [],
        dimension: _raw.nether_ores.includes(ore) ? 'nether' : 'overworld',
    };
}

export function getKnownOres() {
    return Object.keys(ORE_INDEX);
}

export function getOreInfo(name) {
    const key = normalizeOreKey(name);
    return ORE_INDEX[key] || null;
}

export function getOreBlockNames(name) {
    const info = getOreInfo(name);
    return info ? info.block_names.slice() : [];
}

export function getRequiredPickaxe(name) {
    const info = getOreInfo(name);
    return info ? info.min_pickaxe : null;
}

export function getBestY(name, current_y) {
    const info = getOreInfo(name);
    if (!info || !info.best_y_levels || info.best_y_levels.length === 0) return null;
    if (typeof current_y !== 'number') return info.best_y_levels[0];
    let best = info.best_y_levels[0];
    let bestDist = Math.abs(best - current_y);
    for (let i = 1; i < info.best_y_levels.length; i++) {
        const d = Math.abs(info.best_y_levels[i] - current_y);
        if (d < bestDist) {
            best = info.best_y_levels[i];
            bestDist = d;
        }
    }
    return best;
}

export function botHasRequiredPickaxe(bot, name) {
    const info = getOreInfo(name);
    if (!info) return { ok: false, has: null, needs: null, reason: 'unknown_ore' };
    const needs = info.min_pickaxe;
    const needsRank = TIER_RANK[needs] || 1;
    let bestHave = null;
    let bestRank = 0;
    for (const item of bot.inventory.items()) {
        const rank = PICKAXE_RANK[item.name];
        if (rank && rank > bestRank) {
            bestRank = rank;
            bestHave = item.name;
        }
    }
    return {
        ok: bestRank >= needsRank,
        has: bestHave,
        needs,
        reason: bestRank >= needsRank ? 'ok' : (bestHave ? 'tier_too_low' : 'no_pickaxe'),
    };
}
