import crypto from 'crypto';
import path from 'path';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import settings from './settings.js';

const DEFAULT_BRIDGE_TIMEOUT_MS = 750;

function sha256(text) {
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function sanitizeWorldId(id) {
    const safe = String(id || '')
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    return safe || null;
}

function makeIdentity({ worldId, source, confidence, evidence = {}, fingerprint = null }) {
    const safe = sanitizeWorldId(worldId);
    if (!safe) return null;
    return {
        world_id: safe,
        source,
        confidence,
        fingerprint: fingerprint || sha256(`${source}:${safe}`),
        evidence,
    };
}

function readProperties(filePath) {
    const props = {};
    const text = readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return props;
}

function resolveLocalWorldIdentity() {
    const configuredWorldPath = settings.world_path;
    const configuredServerPath = settings.server_path;
    let worldPath = configuredWorldPath;
    let levelName = null;
    let serverPath = configuredServerPath;

    if (!worldPath && configuredServerPath) {
        const propertiesPath = path.join(configuredServerPath, 'server.properties');
        if (existsSync(propertiesPath)) {
            const props = readProperties(propertiesPath);
            levelName = props['level-name'] || 'world';
            worldPath = path.join(configuredServerPath, levelName);
        }
    }

    if (!worldPath || !existsSync(worldPath)) return null;

    const realWorldPath = realpathSync(worldPath);
    const levelDatPath = path.join(realWorldPath, 'level.dat');
    const levelDat = existsSync(levelDatPath) ? statSync(levelDatPath) : null;
    const basis = {
        worldPath: realWorldPath,
        levelName: levelName || path.basename(realWorldPath),
        serverPath: serverPath ? realpathSync(serverPath) : null,
        levelDatSize: levelDat?.size ?? null,
    };
    return makeIdentity({
        worldId: `local_${basis.levelName}_${sha256(realWorldPath).slice(0, 12)}`,
        source: configuredWorldPath ? 'settings.world_path' : 'settings.server_path',
        confidence: 'high',
        fingerprint: sha256(JSON.stringify(basis)),
        evidence: {
            localLevelName: basis.levelName,
            worldPath: basis.worldPath,
            serverPath: basis.serverPath,
            hasLevelDat: Boolean(levelDat),
        },
    });
}

async function resolveJourneyMapIdentity() {
    const baseUrl = settings.journeymap_bridge_url;
    if (!baseUrl || typeof fetch !== 'function') return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.world_identity_bridge_timeout_ms ?? DEFAULT_BRIDGE_TIMEOUT_MS);
    try {
        const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/world`, { signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json();
        const rawId = data.worldId || data.world_id || data.id || data.key || data.worldName || data.world_name;
        if (!rawId) return null;
        return makeIdentity({
            worldId: `journeymap_${rawId}`,
            source: 'journeymap_bridge',
            confidence: 'high',
            fingerprint: sha256(JSON.stringify(data)),
            evidence: { journeyMapWorld: data },
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function protocolEvidence(agent) {
    const bot = agent?.bot;
    const client = bot?._client;
    return {
        protocolWorldName: bot?._getDimensionName?.() || null,
        dimension: bot?.game?.dimension ?? null,
        levelType: bot?.game?.levelType ?? null,
        serverBrand: bot?.game?.serverBrand ?? null,
        version: bot?.version || settings.minecraft_version || null,
        host: settings.host ?? client?.socket?._host ?? null,
        port: settings.port ?? null,
        motd: agent?.server_info?.name ?? null,
    };
}

function resolveProtocolFallback(agent) {
    const evidence = protocolEvidence(agent);
    const worldish = [
        evidence.protocolWorldName,
        evidence.dimension,
        evidence.levelType,
        evidence.serverBrand,
        evidence.version,
    ].filter(Boolean).join(':');
    if (worldish) {
        return makeIdentity({
            worldId: `protocol_${worldish}_${settings.host || 'unknown'}_${settings.port || 'unknown'}`,
            source: 'protocol_session',
            confidence: 'low',
            fingerprint: sha256(JSON.stringify(evidence)),
            evidence,
        });
    }
    if (settings.host || settings.port) {
        return makeIdentity({
            worldId: `server_${settings.host || 'unknown'}_${settings.port || 'unknown'}_${settings.minecraft_version || 'unknown'}`,
            source: 'server_connection',
            confidence: 'low',
            fingerprint: sha256(JSON.stringify(evidence)),
            evidence,
        });
    }
    return null;
}

export async function resolveWorldIdentity(agent) {
    agent?.transcript?.record('world_identity.resolve.start', {}, 'world_identity');

    const configured = makeIdentity({
        worldId: settings.world_id,
        source: 'settings.world_id',
        confidence: 'high',
        evidence: { configuredWorldId: settings.world_id || null },
    });
    const identity = configured
        || await resolveJourneyMapIdentity()
        || resolveLocalWorldIdentity()
        || resolveProtocolFallback(agent)
        || makeIdentity({
            worldId: `temporary_${process.pid}_${Date.now()}`,
            source: 'temporary',
            confidence: 'temporary',
            evidence: protocolEvidence(agent),
        });

    const event = identity.confidence === 'low'
        ? 'world_identity.resolve.low_confidence'
        : identity.confidence === 'temporary'
            ? 'world_identity.resolve.failure'
            : 'world_identity.resolve.success';
    agent?.transcript?.record(event, {
        world_id: identity.world_id,
        source: identity.source,
        confidence: identity.confidence,
        fingerprint: identity.fingerprint,
        evidence: identity.evidence,
    }, 'world_identity');

    return identity;
}
