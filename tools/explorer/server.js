// Mindcraft Bot Explorer
// Local dashboard for understanding, visualizing, and planning improvements
// to the bot's prompt-to-action flow.
//
// Run with: npm run explorer
// Then open: http://localhost:7331

import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Repo root is two levels up: tools/explorer -> tools -> repo root
const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const DATA_DIR   = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.EXPLORER_PORT || 7331);

// ----- helpers --------------------------------------------------------------

async function readJson(file, fallback) {
    try {
        const raw = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw err;
    }
}

async function writeJson(file, data) {
    const full = path.join(DATA_DIR, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Resolve a user-supplied path to an absolute file inside the repo, or null
// if the path escapes the repo. Prevents directory traversal.
function safeResolveRepoPath(rel) {
    if (typeof rel !== 'string' || !rel.length) return null;
    // Reject absolute/Windows-rooted inputs from the client
    if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) return null;
    const abs = path.resolve(REPO_ROOT, rel);
    const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
    if (abs !== REPO_ROOT && !abs.startsWith(rootWithSep)) return null;
    return abs;
}

function ensureDataFilesExist() {
    if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });
    const plansPath = path.join(DATA_DIR, 'plans.json');
    if (!fsSync.existsSync(plansPath)) {
        fsSync.writeFileSync(plansPath, JSON.stringify({
            updatedAt: new Date().toISOString(),
            cards: []
        }, null, 2));
    }
    const notesPath = path.join(DATA_DIR, 'notes.json');
    if (!fsSync.existsSync(notesPath)) {
        fsSync.writeFileSync(notesPath, JSON.stringify({
            updatedAt: new Date().toISOString(),
            byKey: {}
        }, null, 2));
    }
}

// ----- app ------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// --- Static-ish data ---

app.get('/api/flow', async (_req, res) => {
    try {
        const flow = await readJson('flow.json');
        res.json(flow);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/research', async (_req, res) => {
    try {
        const research = await readJson('research.json');
        res.json(research);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Editable data: notes per recommendation/stage ---

app.get('/api/notes', async (_req, res) => {
    try {
        const notes = await readJson('notes.json', { updatedAt: null, byKey: {} });
        res.json(notes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notes/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { text } = req.body || {};
        if (typeof text !== 'string') {
            return res.status(400).json({ error: 'text must be a string' });
        }
        const notes = await readJson('notes.json', { updatedAt: null, byKey: {} });
        if (text.trim().length === 0) {
            delete notes.byKey[key];
        } else {
            notes.byKey[key] = { text, updatedAt: new Date().toISOString() };
        }
        notes.updatedAt = new Date().toISOString();
        await writeJson('notes.json', notes);
        res.json({ ok: true, key, entry: notes.byKey[key] || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Editable data: project plan cards ---

app.get('/api/plans', async (_req, res) => {
    try {
        const plans = await readJson('plans.json', { updatedAt: null, cards: [] });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/plans', async (req, res) => {
    try {
        const { cards } = req.body || {};
        if (!Array.isArray(cards)) {
            return res.status(400).json({ error: 'cards must be an array' });
        }
        const sanitized = cards.map(c => ({
            id: String(c.id),
            title: String(c.title || '').slice(0, 200),
            body: String(c.body || '').slice(0, 4000),
            status: ['backlog', 'planned', 'inprogress', 'done'].includes(c.status) ? c.status : 'backlog',
            tags: Array.isArray(c.tags) ? c.tags.map(t => String(t).slice(0, 40)).slice(0, 10) : [],
            sourceLink: c.sourceLink ? String(c.sourceLink).slice(0, 200) : null,
            createdAt: c.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }));
        const next = { updatedAt: new Date().toISOString(), cards: sanitized };
        await writeJson('plans.json', next);
        res.json(next);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Source viewer: read a slice of a file inside the repo ---

app.get('/api/source', async (req, res) => {
    try {
        const rel = String(req.query.path || '');
        const start = req.query.start ? Math.max(1, parseInt(req.query.start, 10)) : 1;
        const end   = req.query.end   ? Math.max(start, parseInt(req.query.end, 10)) : null;

        const abs = safeResolveRepoPath(rel);
        if (!abs) return res.status(400).json({ error: 'invalid path' });

        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || !stat.isFile()) return res.status(404).json({ error: 'not found' });

        // Cap at 500 KB to keep responses sane.
        if (stat.size > 500 * 1024) return res.status(413).json({ error: 'file too large' });

        const raw = await fs.readFile(abs, 'utf8');
        const lines = raw.split(/\r?\n/);
        const sliceEnd = end ? Math.min(end, lines.length) : lines.length;
        const sliceStart = Math.min(start, lines.length);
        const slice = lines.slice(sliceStart - 1, sliceEnd);

        res.json({
            path: rel.replace(/\\/g, '/'),
            totalLines: lines.length,
            start: sliceStart,
            end: sliceEnd,
            content: slice.join('\n')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Convenience: list known docs/source roots so the UI can browse ---

app.get('/api/repo-info', async (_req, res) => {
    try {
        let pkg = {};
        try {
            pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        } catch { /* noop */ }
        res.json({
            repoRoot: REPO_ROOT,
            name: pkg.name || 'mindcraft',
            version: pkg.version || null,
            scripts: Object.keys(pkg.scripts || {}),
            dependencies: Object.keys(pkg.dependencies || {}).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----- boot -----------------------------------------------------------------

ensureDataFilesExist();

app.listen(PORT, () => {
    /* eslint-disable no-console */
    console.log(`\nMindcraft Bot Explorer`);
    console.log(`  -> http://localhost:${PORT}`);
    console.log(`  repo root: ${REPO_ROOT}`);
    console.log(`  data dir:  ${DATA_DIR}\n`);
});
