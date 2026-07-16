import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { createReadStream, readFileSync, existsSync } from 'fs';
import { readdir, stat, readFile } from 'fs/promises';
import readline from 'readline';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function transcriptEventCountsAsFailure(ev) {
    if (!ev || typeof ev !== 'string') return false;
    if (ev.endsWith('.failure')) return true;
    if (ev === 'model.error' || ev === 'connection.kicked' || ev === 'action.stuck') return true;
    if (ev === 'pathfinder.no_path' || ev === 'pathfinder.timeout') return true;
    return false;
}

function botsRootDir() {
    return path.resolve(process.cwd(), 'bots');
}

/** Single path segment only (session id / bot name / world id). */
function safePathSegment(seg) {
    if (seg == null || typeof seg !== 'string') return null;
    const t = seg.trim();
    if (!t || t.includes('..') || t.includes('/') || t.includes('\\')) return null;
    if (t === '.' || t === '..') return null;
    return t;
}

function resolvedBotDir(nameRaw) {
    const name = safePathSegment(nameRaw);
    if (!name) return null;
    return path.resolve(botsRootDir(), name);
}

function isResolvedUnder(parent, candidate) {
    const rel = path.relative(parent, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveUnderBot(botDir, relPathRaw) {
    const relPath = typeof relPathRaw === 'string' ? relPathRaw.trim() : '';
    const joined = path.resolve(botDir, relPath || '.');
    if (!isResolvedUnder(botDir, joined)) return null;
    return joined;
}

function contentTypeForFile(fileAbs) {
    const ext = path.extname(fileAbs).toLowerCase();
    const map = {
        '.json': 'application/json; charset=utf-8',
        '.jsonl': 'application/x-ndjson; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.csv': 'text/csv; charset=utf-8',
    };
    return map[ext] || 'application/octet-stream';
}

async function summarizeJsonl(pathAbs, id) {
    const st = await stat(pathAbs).catch(() => null);
    if (!st) return null;

    let errorCount = 0;
    let firstTs = null;
    let lastTs = null;

    await new Promise((resolve, reject) => {
        const stream = createReadStream(pathAbs, { encoding: 'utf8' });
        stream.on('error', reject);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            let row;
            try {
                row = JSON.parse(line);
            } catch {
                return;
            }
            const ts = row.ts;
            if (typeof ts === 'string') {
                if (!firstTs) firstTs = ts;
                lastTs = ts;
            }
            const ev = row.event;
            if (transcriptEventCountsAsFailure(ev)) errorCount++;
        });
        rl.on('close', resolve);
        rl.on('error', reject);
    });

    const transcriptDir = path.dirname(pathAbs);
    const botDir = path.dirname(transcriptDir);
    const debugPath = path.join(botDir, 'debug', `${id}.jsonl`);
    const debug_available = existsSync(debugPath);

    return {
        id,
        path: path.relative(process.cwd(), pathAbs),
        size: st.size,
        mtime: st.mtime.toISOString(),
        error_count: errorCount,
        first_ts: firstTs,
        last_ts: lastTs,
        duration_ms:
            firstTs && lastTs
                ? Math.max(0, new Date(lastTs).getTime() - new Date(firstTs).getTime())
                : null,
        debug_available,
    };
}

/**
 * Reads JSONL with optional filters. skip = filtered rows skipped; limit ≤ maxLines.
 */
async function pageJsonl(fileAbs, { stageFilters, since, until, limit, skip, eventRegex }) {
    const maxLimit = Math.min(Math.max(Number(limit) || 200, 1), 2000);
    const skipN = Math.max(Number(skip) || 0, 0);
    const stages =
        typeof stageFilters === 'string' && stageFilters.trim()
            ? stageFilters
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : null;
    const sinceStr = typeof since === 'string' && since.trim() ? since.trim() : null;
    const untilStr = typeof until === 'string' && until.trim() ? until.trim() : null;
    let re = null;
    if (eventRegex) {
        try {
            re = new RegExp(eventRegex);
        } catch {
            re = /\b\B/; // never matches valid line
        }
    }

    const buffered = [];
    let filteredSeen = 0;

    await new Promise((resolve, reject) => {
        const stream = createReadStream(fileAbs, { encoding: 'utf8' });
        stream.on('error', reject);
        let lineNum = 0;
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        function stopEarly() {
            rl.close();
            try {
                stream.destroy();
            } catch {
                /* ignore */
            }
        }

        rl.on('line', (line) => {
            lineNum++;
            if (!line.trim()) return;
            let obj;
            try {
                obj = JSON.parse(line);
            } catch {
                return;
            }
            const evName = obj.event;
            if (re && (typeof evName !== 'string' || !re.test(evName))) return;
            if (stages?.length) {
                const lane = obj.stage === null || obj.stage === undefined || obj.stage === '' ? 'legacy' : obj.stage;
                if (!stages.includes(lane)) return;
            }
            if (sinceStr && typeof obj.ts === 'string' && obj.ts < sinceStr) return;
            if (untilStr && typeof obj.ts === 'string' && obj.ts > untilStr) return;

            if (filteredSeen++ < skipN) return;

            buffered.push({ line: lineNum, ...obj });

            if (buffered.length > maxLimit) {
                stopEarly();
            }
        });
        rl.on('close', resolve);
        rl.on('error', reject);
    });

    const has_more = buffered.length > maxLimit;
    const events = has_more ? buffered.slice(0, maxLimit) : buffered;

    return {
        events,
        has_more,
        skip: skipN,
        next_skip: skipN + events.length,
        limit_used: maxLimit,
    };
}

function readJsonlLineAtSimple(fileAbs, lineNum1Based) {
    return new Promise((resolve, reject) => {
        const n = Number(lineNum1Based);
        if (!Number.isInteger(n) || n < 1) return resolve(null);
        let idx = 0;
        let done = false;
        const finish = (val) => {
            if (done) return;
            done = true;
            resolve(val);
        };
        const stream = createReadStream(fileAbs, { encoding: 'utf8' });
        stream.on('error', reject);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            idx++;
            if (idx === n) {
                rl.close();
                stream.destroy();
                try {
                    const obj = JSON.parse(line);
                    finish({ line: n, ...obj });
                } catch {
                    finish({ line: n, raw: line, parse_error: true });
                }
            }
        });
        rl.on('close', () => {
            if (idx < n) finish(null);
        });
        rl.on('error', reject);
    });
}

function inspectApiForbidden(host_public, res) {
    if (!host_public) return false;
    res.status(403).type('text/plain').send('Inspect API disabled when host_public is true (MindServer Inspect is localhost-only tooling).');
    return true;
}

function attachInspectRoutes(app, host_public) {
    const guard = (_req, res, next) => {
        if (inspectApiForbidden(host_public, res)) return;
        next();
    };

    app.get('/api/bots', guard, async (_req, res) => {
        try {
            const root = botsRootDir();
            const entries = await readdir(root, { withFileTypes: true });
            const names = entries
                .filter((e) => e.isDirectory() && safePathSegment(e.name) && e.name !== '_worlds')
                .map((e) => e.name);
            names.sort();
            res.json({ bots: names });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/files', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        const rel = req.query.path != null ? String(req.query.path) : '';
        const abs = resolveUnderBot(botDir, rel);
        if (!abs) {
            res.status(400).json({ error: 'path escapes bot directory (traversal rejected)' });
            return;
        }
        try {
            const st = await stat(abs).catch(() => null);
            if (!st || !st.isDirectory()) {
                res.status(400).json({ error: 'not a directory or missing' });
                return;
            }
            const ents = await readdir(abs, { withFileTypes: true });
            const mapped = [];
            for (const e of ents) {
                const p = resolveUnderBot(botDir, path.join(rel.replace(/\\/g, '/'), e.name));
                if (!p) continue;
                const s = await stat(p).catch(() => null);
                if (!s) continue;
                mapped.push({
                    name: e.name,
                    type: e.isDirectory() ? 'dir' : 'file',
                    size: e.isDirectory() ? null : s.size,
                    mtime: s.mtime.toISOString(),
                });
            }
            mapped.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
            res.json({
                bot: req.params.name,
                path: rel.replace(/\\/g, '/'),
                entries: mapped,
            });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/file', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        const rel = req.query.path != null ? String(req.query.path) : '';
        const abs = resolveUnderBot(botDir, rel);
        if (!abs) {
            res.status(400).json({ error: 'path escapes bot directory (traversal rejected)' });
            return;
        }
        try {
            const st = await stat(abs).catch(() => null);
            if (!st || !st.isFile()) {
                res.status(400).json({ error: 'not a file or missing' });
                return;
            }
            const buf = await readFile(abs);
            res.type(contentTypeForFile(abs)).send(buf);
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/sessions', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        const tsDir = path.join(botDir, 'transcripts');
        if (!existsSync(tsDir)) {
            res.json({ bot: req.params.name, sessions: [] });
            return;
        }
        try {
            const files = (await readdir(tsDir)).filter((f) => f.endsWith('.jsonl'));
            const summaries = await Promise.all(
                files.map(async (f) => {
                    const id = f.slice(0, -'.jsonl'.length);
                    if (!safePathSegment(id)) return null;
                    return summarizeJsonl(path.join(tsDir, f), id);
                }),
            );
            const sessions = summaries.filter(Boolean).sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
            res.json({ bot: req.params.name, sessions });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/sessions/:sessionId/events', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        const sessionId = safePathSegment(req.params.sessionId);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        if (!sessionId) {
            res.status(400).json({ error: 'invalid session id' });
            return;
        }
        const fileAbs = path.join(botDir, 'transcripts', `${sessionId}.jsonl`);
        if (!existsSync(fileAbs)) {
            res.status(404).json({ error: 'session not found' });
            return;
        }
        try {
            const result = await pageJsonl(fileAbs, {
                stageFilters: typeof req.query.stage === 'string' ? req.query.stage : '',
                since: typeof req.query.since === 'string' ? req.query.since : '',
                until: typeof req.query.until === 'string' ? req.query.until : '',
                limit: req.query.limit,
                skip: req.query.skip ?? req.query.cursor,
                eventRegex: typeof req.query.event_regex === 'string' ? req.query.event_regex : null,
            });
            res.json({
                bot: req.params.name,
                session_id: sessionId,
                source: 'transcript',
                ...result,
            });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/sessions/:sessionId/debug/events', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        const sessionId = safePathSegment(req.params.sessionId);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        if (!sessionId) {
            res.status(400).json({ error: 'invalid session id' });
            return;
        }
        const fileAbs = path.join(botDir, 'debug', `${sessionId}.jsonl`);
        if (!existsSync(fileAbs)) {
            res.status(404).json({ error: 'debug transcript not found' });
            return;
        }
        try {
            const result = await pageJsonl(fileAbs, {
                stageFilters: typeof req.query.stage === 'string' ? req.query.stage : '',
                since: typeof req.query.since === 'string' ? req.query.since : '',
                until: typeof req.query.until === 'string' ? req.query.until : '',
                limit: req.query.limit,
                skip: req.query.skip ?? req.query.cursor,
                eventRegex: typeof req.query.event_regex === 'string' ? req.query.event_regex : null,
            });
            res.json({
                bot: req.params.name,
                session_id: sessionId,
                source: 'debug',
                ...result,
            });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/bots/:name/sessions/:sessionId/event/:lineNum', guard, async (req, res) => {
        const botDir = resolvedBotDir(req.params.name);
        const sessionId = safePathSegment(req.params.sessionId);
        if (!botDir || !existsSync(botDir)) {
            res.status(404).json({ error: 'unknown bot' });
            return;
        }
        if (!sessionId) {
            res.status(400).json({ error: 'invalid session id' });
            return;
        }
        const fileAbs = path.join(botDir, 'transcripts', `${sessionId}.jsonl`);
        if (!existsSync(fileAbs)) {
            res.status(404).json({ error: 'session not found' });
            return;
        }
        try {
            const row = await readJsonlLineAtSimple(fileAbs, req.params.lineNum);
            if (!row) {
                res.status(404).json({ error: 'line not found' });
                return;
            }
            res.json({ bot: req.params.name, session_id: sessionId, source: 'transcript', event: row });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/worlds', guard, async (_req, res) => {
        try {
            const worldsRoot = path.resolve(botsRootDir(), '_worlds');
            if (!existsSync(worldsRoot)) {
                res.json({ worlds: [] });
                return;
            }
            const dirs = await readdir(worldsRoot, { withFileTypes: true });
            const worlds = [];
            for (const d of dirs) {
                if (!d.isDirectory()) continue;
                const id = d.name;
                if (!safePathSegment(id)) continue;
                const mem = path.join(worldsRoot, id, 'memory.json');
                const st = await stat(mem).catch(() => null);
                worlds.push({
                    id,
                    memory_path: path.relative(process.cwd(), mem),
                    size: st?.size ?? null,
                    mtime: st ? st.mtime.toISOString() : null,
                    exists: !!st?.isFile(),
                });
            }
            worlds.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            res.json({ worlds });
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/workspace/file', guard, async (req, res) => {
        const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';
        const root = process.cwd();
        if (!raw || path.isAbsolute(raw)) {
            res.status(400).json({ error: 'invalid path (must be relative to project root)' });
            return;
        }
        const norm = path.normalize(raw).replace(/^[\\/]+/, '');
        if (norm.includes('..')) {
            res.status(400).json({ error: 'invalid path (traversal rejected)' });
            return;
        }
        const abs = path.resolve(root, norm);
        if (!isResolvedUnder(root, abs)) {
            res.status(400).json({ error: 'path escapes workspace' });
            return;
        }
        try {
            if (!existsSync(abs)) {
                res.status(404).json({ error: 'not found' });
                return;
            }
            const st = await stat(abs).catch(() => null);
            if (!st?.isFile()) {
                res.status(400).json({ error: 'not a file' });
                return;
            }
            const buf = await readFile(abs);
            res.type(contentTypeForFile(abs)).send(buf);
        } catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });

    app.get('/api/worlds/:worldId', guard, async (req, res) => {
        const id = safePathSegment(req.params.worldId);
        if (!id) {
            res.status(400).json({ error: 'invalid world id' });
            return;
        }
        const worldsRoot = path.resolve(botsRootDir(), '_worlds');
        const abs = resolveUnderBot(worldsRoot, path.join(id, 'memory.json'));
        if (!abs) {
            res.status(400).json({ error: 'invalid path' });
            return;
        }
        try {
            if (!existsSync(abs)) {
                res.status(404).json({ error: 'memory.json not found' });
                return;
            }
            const raw = await readFile(abs, 'utf8');
            const data = JSON.parse(raw);
            res.json({ world_id: id, memory: data });
        } catch (e) {
            if (e instanceof SyntaxError) {
                res.status(400).json({ error: 'invalid JSON in memory file' });
                return;
            }
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
}

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public', 'settings_spec.json'), 'utf8'));

function cloneSettingValue(value) {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
}

function validateSettingType(key, value, spec) {
    if (value === null) {
        if (spec.required || spec.default !== null) {
            return `Setting ${key} must be ${spec.type}`;
        }
        return null;
    }
    if (spec.type === 'array') {
        return Array.isArray(value) ? null : `Setting ${key} must be array`;
    }
    if (spec.type === 'object') {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? null
            : `Setting ${key} must be object`;
    }
    if (spec.type === 'number') {
        return typeof value === 'number' && Number.isFinite(value)
            ? null
            : `Setting ${key} must be number`;
    }
    if (spec.type === 'boolean') {
        return typeof value === 'boolean' ? null : `Setting ${key} must be boolean`;
    }
    if (spec.type === 'string') {
        return typeof value === 'string' ? null : `Setting ${key} must be string`;
    }
    return null;
}

export function normalizeMindServerSettings(rawSettings) {
    if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
        return { ok: false, error: 'Settings must be an object' };
    }
    const normalized = {};
    for (const [key, spec] of Object.entries(settings_spec)) {
        if (!(key in rawSettings)) {
            if (spec.required) {
                return { ok: false, error: `Setting ${key} is required` };
            }
            normalized[key] = cloneSettingValue(spec.default);
            continue;
        }
        const value = rawSettings[key];
        const typeError = validateSettingType(key, value, spec);
        if (typeError) {
            return { ok: false, error: typeError };
        }
        if (spec.options && value !== null && !spec.options.includes(value)) {
            return { ok: false, error: `Setting ${key} must be one of: ${spec.options.join(', ')}` };
        }
        normalized[key] = cloneSettingValue(value);
    }
    return { ok: true, settings: normalized };
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    const webRoot = path.join(__dirname, 'public');

    attachInspectRoutes(app, host_public);

    // Serve static files
    app.use(express.static(webRoot));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            const normalized = normalizeMindServerSettings(settings);
            if (!normalized.ok) {
                callback({ success: false, error: normalized.error });
                return;
            }
            settings = normalized.settings;
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', (reason) => {
            let matchedAgent = null;
            for (const n of Object.keys(agent_connections)) {
                if (agent_connections[n].socket === socket) {
                    matchedAgent = n;
                    break;
                }
            }
            const disconnectAgentName = curAgentName || matchedAgent;
            if (agent_connections[disconnectAgentName]) {
                console.log(`Agent ${disconnectAgentName} disconnected (${reason})`);
                agent_connections[disconnectAgentName].in_game = false;
                agent_connections[disconnectAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (!agent) {
                socket.emit('settings-error', agentName, `Unknown agent: ${agentName}`);
                return;
            }
            if (!agent.socket) {
                socket.emit('settings-error', agentName, `Agent is not connected: ${agentName}`);
                return;
            }
            const normalized = normalizeMindServerSettings(settings);
            if (!normalized.ok) {
                socket.emit('settings-error', agentName, normalized.error);
                return;
            }
            agent.setSettings(normalized.settings);
            agent.socket.emit('restart-agent');
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            const agent = agent_connections[agentName];
            if (!agent?.socket) {
                socket.emit('settings-error', agentName, `Agent is not connected: ${agentName}`);
                return;
            }
            agent.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('transcript-event', (payload) => {
            if (!payload || typeof payload.agent !== 'string') return;
            io.emit('transcript-event', payload);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
