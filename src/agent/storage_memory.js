export function storageKeyFromPosition(pos) {
    return `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
}

export function aggregateContainerItems(items) {
    const counts = {};
    for (const item of items || []) {
        if (!item?.name) continue;
        counts[item.name] = (counts[item.name] || 0) + (item.count || 0);
    }
    return counts;
}

export function makeStorageRecord(name, block, items = [], extra = {}) {
    const pos = block.position || block;
    const now = new Date().toISOString();
    const contentsIndexedAt = extra.contentsIndexedAt || extra.indexedAt || now;
    return {
        name,
        key: storageKeyFromPosition(pos),
        block: block.name || extra.block || 'storage',
        x: pos.x,
        y: pos.y,
        z: pos.z,
        dimension: extra.dimension ?? null,
        counts: aggregateContainerItems(items),
        contentsIndexedAt,
        indexedAt: contentsIndexedAt,
        updatedAt: extra.updatedAt || now,
        verifiedAt: extra.verifiedAt || null,
        source: extra.source || 'storage_index',
    };
}

export function searchStorage(storageRecords, itemName) {
    const needle = String(itemName || '').toLowerCase();
    const matches = [];
    for (const [key, record] of Object.entries(storageRecords || {})) {
        const counts = record.counts || {};
        const found = {};
        for (const [name, count] of Object.entries(counts)) {
            if (name.toLowerCase().includes(needle) && count > 0) {
                found[name] = count;
            }
        }
        if (Object.keys(found).length > 0) {
            matches.push({ key, record, found });
        }
    }
    matches.sort((a, b) => {
        const aTotal = Object.values(a.found).reduce((sum, n) => sum + n, 0);
        const bTotal = Object.values(b.found).reduce((sum, n) => sum + n, 0);
        return bTotal - aTotal;
    });
    return matches;
}
