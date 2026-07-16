import settings from './settings.js';
import os from 'os';
import path from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import nbt from 'prismarine-nbt';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47892';
const WAYPOINT_DATA_FILE = 'WaypointData.dat';

export function journeyMapBridgeUrl() {
    return (settings.journeymap_bridge_url || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
}

function parseScalar(value) {
    const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

export function parseJourneyMapLocation(text) {
    const now = new Date().toISOString();
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
            importedAt: now,
            updatedAt: now,
            verifiedAt: now,
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

function uniqueExistingPaths(paths) {
    return [...new Set(paths.filter(Boolean))].filter(candidate => existsSync(candidate));
}

function findWaypointDataFiles(root, limit = 200) {
    const found = [];
    const stack = [root];
    while (stack.length && found.length < limit) {
        const current = stack.pop();
        let stat;
        try {
            stat = statSync(current);
        } catch {
            continue;
        }
        if (stat.isFile()) {
            if (path.basename(current) === WAYPOINT_DATA_FILE) found.push(current);
            continue;
        }
        if (!stat.isDirectory()) continue;
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && ['icon', 'config', 'server', 'web'].includes(entry.name)) continue;
            const child = path.join(current, entry.name);
            if (entry.isFile() && entry.name === WAYPOINT_DATA_FILE) found.push(child);
            else if (entry.isDirectory()) stack.push(child);
            if (found.length >= limit) break;
        }
    }
    return found;
}

function configuredWaypointRoots() {
    const configured = settings.journeymap_waypoints_path || settings.journeymap_data_path;
    if (configured) return uniqueExistingPaths([path.resolve(String(configured))]);
    if (settings.journeymap_auto_discover_waypoints === false) return [];

    const home = os.homedir();
    return uniqueExistingPaths([
        process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'journeymap', 'data'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'CurseForge', 'minecraft', 'Instances'),
        home && path.join(home, 'curseforge', 'minecraft', 'Instances'),
    ]);
}

function hasConfiguredWaypointPath() {
    return Boolean(settings.journeymap_waypoints_path || settings.journeymap_data_path);
}

function waypointFilesFromSettings() {
    const files = [];
    for (const root of configuredWaypointRoots()) {
        const stat = statSync(root);
        if (stat.isFile()) files.push(root);
        else files.push(...findWaypointDataFiles(root));
    }
    return [...new Set(files)]
        .map(file => ({ file, mtimeMs: statSync(file).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(entry => entry.file);
}

export async function parseJourneyMapWaypointData(buffer, { sourcePath = null } = {}) {
    const parsed = await nbt.parse(buffer);
    const data = nbt.simplify(parsed.parsed);
    const waypoints = data?.waypoints && typeof data.waypoints === 'object' ? data.waypoints : {};
    return Object.values(waypoints).map(raw => {
        const pos = raw?.pos || {};
        return {
            name: raw?.name,
            id: raw?.guid,
            x: pos.x ?? raw?.x,
            y: pos.y ?? raw?.y,
            z: pos.z ?? raw?.z,
            dimension: pos.dimension ?? raw?.dimension ?? raw?.dimensions?.[0] ?? null,
            color: raw?.color ?? null,
            enabled: raw?.settings?.enable !== 0,
            groupId: raw?.groupId ?? null,
            modId: raw?.modId ?? null,
            sourcePath,
            raw,
        };
    });
}

export async function fetchLocalJourneyMapWaypoints() {
    const files = waypointFilesFromSettings();
    const waypoints = [];
    const sources = [];
    for (const file of files) {
        const parsed = await parseJourneyMapWaypointData(readFileSync(file), { sourcePath: file });
        if (parsed.length > 0) {
            waypoints.push(...parsed);
            sources.push(file);
            if (!hasConfiguredWaypointPath()) break;
        }
    }
    if (waypoints.length === 0) {
        throw new Error(files.length ? 'journeymap_waypoint_files_empty' : 'journeymap_waypoint_files_missing');
    }
    return { waypoints, source: 'journeymap_file', sources };
}

export async function fetchJourneyMapWaypoints() {
    try {
        return {
            waypoints: await fetchBridgeWaypoints(),
            source: 'journeymap_bridge',
            sources: [journeyMapBridgeUrl()],
        };
    } catch (bridgeError) {
        try {
            const local = await fetchLocalJourneyMapWaypoints();
            return {
                ...local,
                bridgeError,
            };
        } catch (localError) {
            localError.bridgeError = bridgeError;
            throw localError;
        }
    }
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
    const now = new Date().toISOString();
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
        importedAt: now,
        updatedAt: now,
        verifiedAt: now,
        raw,
    };
}

function equivalentWaypoint(a, b) {
    return a?.x === b?.x
        && (a?.y ?? null) === (b?.y ?? null)
        && a?.z === b?.z
        && (a?.dimension ?? null) === (b?.dimension ?? null);
}

export function mergeJourneyMapWaypoints(memoryBank, rawWaypoints = [], { source = 'journeymap_bridge' } = {}) {
    const stats = { imported: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const raw of rawWaypoints || []) {
        const normalized = normalizeBridgeWaypoint(raw);
        if (!normalized) {
            stats.skipped++;
            continue;
        }
        const existing = memoryBank.recall('journeymap.waypoints', normalized.name);
        const merged = {
            ...(existing || {}),
            ...normalized,
            name: existing?.name || normalized.name,
            label: existing?.label ?? normalized.label,
            labels: existing?.labels ?? normalized.labels,
            aliases: existing?.aliases ?? normalized.aliases,
            source,
            updatedAt: normalized.updatedAt,
            verifiedAt: normalized.verifiedAt,
        };
        if (!existing) {
            memoryBank.remember('journeymap.waypoints', normalized.name, merged);
            stats.imported++;
        } else if (!equivalentWaypoint(existing, merged) || existing.source !== merged.source || existing.verifiedAt !== merged.verifiedAt || !existing.updatedAt) {
            memoryBank.remember('journeymap.waypoints', normalized.name, merged);
            stats.updated++;
        } else {
            stats.unchanged++;
        }
    }
    return stats;
}
