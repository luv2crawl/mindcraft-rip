import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { MemoryBank } from './memory_bank.js';
import { sanitizeWorldId } from './world_identity.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasTypedNamespace(data) {
    return ['places', 'journeymap', 'routes', 'storage', 'observations', 'pending']
        .some(key => Object.prototype.hasOwnProperty.call(data, key));
}

function looksLikeLegacyPlace(value) {
    if (Array.isArray(value)) {
        return value.length >= 3
            && Number.isFinite(Number(value[0]))
            && Number.isFinite(Number(value[1]))
            && Number.isFinite(Number(value[2]));
    }
    return isPlainObject(value)
        && Number.isFinite(Number(value.x))
        && Number.isFinite(Number(value.z))
        && (value.y === undefined || Number.isFinite(Number(value.y)));
}

function looksLikeLegacyFlatMemory(data) {
    const entries = Object.entries(data || {});
    return entries.length > 0 && entries.every(([, value]) => looksLikeLegacyPlace(value));
}

function isWorldMemoryWrapper(data) {
    return isPlainObject(data)
        && (
            Object.prototype.hasOwnProperty.call(data, 'world_identity')
            || Object.prototype.hasOwnProperty.call(data, 'memory_bank')
            || Object.prototype.hasOwnProperty.call(data, 'saved_at')
        );
}

function extractMemoryBankJson(data) {
    if (!isPlainObject(data)) {
        throw new Error('world_memory_not_object');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'memory_bank')) {
        if (!isPlainObject(data.memory_bank)) {
            throw new Error('world_memory_missing_memory_bank');
        }
        return data.memory_bank;
    }
    if (isWorldMemoryWrapper(data)) {
        throw new Error('world_memory_missing_memory_bank');
    }
    if (hasTypedNamespace(data) || looksLikeLegacyFlatMemory(data)) {
        return data;
    }
    throw new Error('world_memory_unrecognized_shape');
}

function readMemoryBankJson(memoryPath) {
    const data = JSON.parse(readFileSync(memoryPath, 'utf8'));
    return extractMemoryBankJson(data);
}

function backupInvalidWorldMemory(agent, memoryPath, error) {
    const backup = `${memoryPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        renameSync(memoryPath, backup);
    } catch {}
    agent.transcript?.record('world_memory.load.failure', {
        path: memoryPath,
        backup,
        error: error?.message || String(error),
    }, 'world_memory');
    return backup;
}

function hasEntries(value) {
    if (!isPlainObject(value)) return false;
    return Object.values(value).some(entry => {
        if (!isPlainObject(entry)) return entry !== undefined && entry !== null;
        return Object.keys(entry).length > 0;
    });
}

function memoryTimestamp(record) {
    const candidates = [
        record?.verifiedAt,
        record?.updatedAt,
        record?.contentsIndexedAt,
        record?.indexedAt,
        record?.importedAt,
        record?.createdAt,
        record?.saved_at,
    ].map(value => Date.parse(value)).filter(Number.isFinite);
    return candidates.length ? Math.max(...candidates) : 0;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeMemoryJson(base, incoming) {
    if (!isPlainObject(base)) return clone(incoming || {});
    if (!isPlainObject(incoming)) return clone(base);

    const merged = clone(base);
    for (const [key, value] of Object.entries(incoming)) {
        const existing = merged[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            const existingLooksLikeRecord = memoryTimestamp(existing) > 0
                || Object.prototype.hasOwnProperty.call(existing, 'x')
                || Object.prototype.hasOwnProperty.call(existing, 'counts')
                || Object.prototype.hasOwnProperty.call(existing, 'breadcrumbs');
            const valueLooksLikeRecord = memoryTimestamp(value) > 0
                || Object.prototype.hasOwnProperty.call(value, 'x')
                || Object.prototype.hasOwnProperty.call(value, 'counts')
                || Object.prototype.hasOwnProperty.call(value, 'breadcrumbs');
            if (existingLooksLikeRecord || valueLooksLikeRecord) {
                merged[key] = memoryTimestamp(existing) > memoryTimestamp(value)
                    ? clone(existing)
                    : clone(value);
            } else {
                merged[key] = mergeMemoryJson(existing, value);
            }
        } else {
            merged[key] = clone(value);
        }
    }
    return merged;
}

function mergeMissingMemoryJson(base, incoming) {
    if (!isPlainObject(base)) return clone(incoming || {});
    if (!isPlainObject(incoming)) return clone(base);

    const merged = clone(base);
    for (const [key, value] of Object.entries(incoming)) {
        const existing = merged[key];
        if (existing === undefined) {
            merged[key] = clone(value);
        } else if (isPlainObject(existing) && isPlainObject(value)) {
            merged[key] = mergeMissingMemoryJson(existing, value);
        }
    }
    return merged;
}

function mergeLegacyMemory(bank, legacyMemoryBank) {
    if (!isPlainObject(legacyMemoryBank) || !hasEntries(legacyMemoryBank)) return false;
    const legacy = new MemoryBank();
    legacy.loadJson(legacyMemoryBank);
    const before = JSON.stringify(bank.getJson());
    bank.loadJson(mergeMissingMemoryJson(bank.getJson(), legacy.getJson()));
    return JSON.stringify(bank.getJson()) !== before;
}

export function getWorldMemoryPath(worldIdentity) {
    if (worldIdentity?.confidence === 'temporary') return null;
    const safeWorldId = sanitizeWorldId(worldIdentity?.world_id);
    if (!safeWorldId) return null;
    return path.join('.', 'bots', '_worlds', safeWorldId, 'memory.json');
}

export function loadWorldMemory(agent, worldIdentity, { legacyMemoryBank = null } = {}) {
    const memoryPath = getWorldMemoryPath(worldIdentity);
    const bank = new MemoryBank();
    if (!memoryPath) {
        agent.memory_bank = bank;
        return { loaded: false, path: null, migratedLegacy: false };
    }

    mkdirSync(path.dirname(memoryPath), { recursive: true });
    let loaded = false;
    if (existsSync(memoryPath)) {
        try {
            bank.loadJson(readMemoryBankJson(memoryPath));
            loaded = true;
        } catch (error) {
            backupInvalidWorldMemory(agent, memoryPath, error);
        }
    }

    let migratedLegacy = false;
    const highConfidence = ['high', 'medium'].includes(worldIdentity?.confidence);
    if (legacyMemoryBank && highConfidence) {
        migratedLegacy = mergeLegacyMemory(bank, legacyMemoryBank);
    } else if (!loaded && legacyMemoryBank) {
        agent.transcript?.record('world_memory.migrate_legacy.skipped', {
            path: memoryPath,
            world_id: worldIdentity?.world_id,
            confidence: worldIdentity?.confidence,
        }, 'world_memory');
    }
    if (migratedLegacy) {
        bank.dirty = true;
    }

    agent.memory_bank = bank;
    agent.world_memory_path = memoryPath;
    agent.transcript?.record('world_memory.load', {
        path: memoryPath,
        loaded,
        migrated_legacy: migratedLegacy,
        world_id: worldIdentity?.world_id,
        confidence: worldIdentity?.confidence,
    }, 'world_memory');

    if (migratedLegacy) {
        agent.transcript?.record('world_memory.migrate_legacy', {
            path: memoryPath,
            world_id: worldIdentity?.world_id,
        }, 'world_memory');
    }
    return { loaded, path: memoryPath, migratedLegacy };
}

export function saveWorldMemory(agent) {
    const memoryPath = agent.world_memory_path || getWorldMemoryPath(agent.world_identity);
    if (!memoryPath || !agent.memory_bank) return false;
    mkdirSync(path.dirname(memoryPath), { recursive: true });
    let memoryBankJson = agent.memory_bank.getJson();
    if (existsSync(memoryPath)) {
        try {
            memoryBankJson = mergeMemoryJson(readMemoryBankJson(memoryPath), memoryBankJson);
        } catch (error) {
            backupInvalidWorldMemory(agent, memoryPath, error);
        }
    }
    const data = {
        world_identity: agent.world_identity || null,
        memory_bank: memoryBankJson,
        saved_at: new Date().toISOString(),
    };
    const tmp = `${memoryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, memoryPath);
    agent.memory_bank.loadJson(memoryBankJson);
    agent.memory_bank.markClean?.();
    agent.transcript?.record('world_memory.save', {
        path: memoryPath,
        world_id: agent.world_identity?.world_id,
        confidence: agent.world_identity?.confidence,
    }, 'world_memory');
    return true;
}
