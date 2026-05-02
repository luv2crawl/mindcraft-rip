import settings from './settings.js';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47892';

export function journeyMapBridgeUrl() {
    return (settings.journeymap_bridge_url || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
}

function parseScalar(value) {
    const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

export function parseJourneyMapLocation(text) {
    const body = String(text || '').match(/\[(.*)\]/)?.[1] ?? String(text || '');
    const fields = {};
    for (const part of body.split(',')) {
        const match = part.trim().match(/^([a-zA-Z_][\w -]*)\s*:\s*(.+)$/);
        if (!match) continue;
        fields[match[1].trim().toLowerCase()] = parseScalar(match[2]);
    }

    if (typeof fields.x !== 'number' || typeof fields.z !== 'number') {
        return {
            ok: false,
            reason: 'missing_coordinates',
            missing: {
                ...(typeof fields.x !== 'number' ? { x: 1 } : {}),
                ...(typeof fields.z !== 'number' ? { z: 1 } : {}),
            },
        };
    }

    return {
        ok: true,
        waypoint: {
            name: fields.name ? String(fields.name) : `jm_${fields.x}_${fields.z}`,
            x: fields.x,
            y: typeof fields.y === 'number' ? fields.y : null,
            z: fields.z,
            dimension: fields.dim ?? fields.dimension ?? null,
            source: 'journeymap_import',
            importedAt: new Date().toISOString(),
            raw: String(text || ''),
        },
    };
}

async function bridgeFetch(path, options = {}) {
    const response = await fetch(`${journeyMapBridgeUrl()}${path}`, {
        ...options,
        headers: {
            'content-type': 'application/json',
            ...(options.headers || {}),
        },
    });
    if (!response.ok) {
        throw new Error(`bridge_http_${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
}

export async function getBridgeStatus() {
    return await bridgeFetch('/status');
}

export async function fetchBridgeWaypoints() {
    const payload = await bridgeFetch('/waypoints');
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.waypoints)) return payload.waypoints;
    return [];
}

export async function postBridgeWaypoint(waypoint) {
    return await bridgeFetch('/waypoints', {
        method: 'POST',
        body: JSON.stringify(waypoint),
    });
}

export async function postBridgeMarker(marker) {
    return await bridgeFetch('/markers', {
        method: 'POST',
        body: JSON.stringify(marker),
    });
}

export function normalizeBridgeWaypoint(raw) {
    if (!raw) return null;
    const name = String(raw.name || raw.id || raw.label || '').trim();
    const x = Number(raw.x ?? raw.pos?.x);
    const yRaw = raw.y ?? raw.pos?.y;
    const y = yRaw == null ? null : Number(yRaw);
    const z = Number(raw.z ?? raw.pos?.z);
    if (!name || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    return {
        name,
        x,
        y: Number.isFinite(y) ? y : null,
        z,
        dimension: raw.dimension ?? raw.dim ?? null,
        source: 'journeymap_bridge',
        importedAt: new Date().toISOString(),
        raw,
    };
}

