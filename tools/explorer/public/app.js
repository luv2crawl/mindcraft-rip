// Mindcraft Bot Explorer — frontend
// All state is fetched from /api/{flow,research,plans,notes,repo-info}
// and persisted via PUT /api/{notes,plans}.

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
    flow: null,
    research: null,
    notes: { byKey: {} },
    plans: { cards: [] },
    repoInfo: null,
    activeStageId: null,
    activeRecForNote: null,
    cardEditId: null
};

// ----- bootstrap ------------------------------------------------------------

(async function init() {
    bindStaticUI();

    try {
        const [flow, research, notes, plans, repoInfo] = await Promise.all([
            fetchJson('/api/flow'),
            fetchJson('/api/research'),
            fetchJson('/api/notes'),
            fetchJson('/api/plans'),
            fetchJson('/api/repo-info')
        ]);
        state.flow = flow;
        state.research = research;
        state.notes = notes;
        state.plans = plans;
        state.repoInfo = repoInfo;
    } catch (err) {
        console.error('Failed to load explorer data', err);
        document.body.innerHTML =
            `<div style="padding:24px;color:#f6707b;font-family:sans-serif">
              Failed to load explorer data: ${escapeHtml(err.message)}.
              Did you run <code>npm run explorer</code> from the repo root?
             </div>`;
        return;
    }

    renderRepoInfo();
    renderFlow();
    renderResearch();
    renderPlans();
    renderDrift();
    await renderDiagram();
})();

// ----- helpers --------------------------------------------------------------

async function fetchJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortPath(p) {
    if (!p) return '';
    const parts = p.split('/');
    if (parts.length <= 3) return p;
    return parts.slice(-3).join('/');
}

function uid() {
    return 'c_' + Math.random().toString(36).slice(2, 10);
}

function noteKey(kind, id) { return `${kind}:${id}`; }

function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ----- static UI binding ----------------------------------------------------

function bindStaticUI() {
    // Tab switching
    $$('.tab').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
            const target = btn.dataset.tab;
            $$('.tab-panel').forEach(p =>
                p.classList.toggle('active', p.id === `tab-${target}`));
        });
    });

    // Drawer
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerNoteSave').addEventListener('click', saveDrawerNote);
    $('#drawerNoteToCard').addEventListener('click', sendDrawerNoteToPlans);

    // Source modal
    $('#sourceClose').addEventListener('click', () => $('#sourceModal').classList.remove('open'));
    $('#sourceModal').addEventListener('click', (e) => {
        if (e.target.id === 'sourceModal') $('#sourceModal').classList.remove('open');
    });

    // Card modal
    $('#cardClose').addEventListener('click', closeCardModal);
    $('#cardCancel').addEventListener('click', closeCardModal);
    $('#cardSave').addEventListener('click', saveCardModal);
    $('#cardDelete').addEventListener('click', deleteCardModal);
    $('#cardModal').addEventListener('click', (e) => {
        if (e.target.id === 'cardModal') closeCardModal();
    });
    $('#addCard').addEventListener('click', () => openCardModal(null));

    // Esc closes everything
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDrawer();
            closeCardModal();
            $('#sourceModal').classList.remove('open');
        }
    });
}

function renderRepoInfo() {
    const r = state.repoInfo;
    if (!r) return;
    $('#repoInfo').innerHTML =
        `<code>${escapeHtml(r.name)}</code> · ${r.dependencies} deps ·
         <code>${escapeHtml(r.repoRoot)}</code>`;
}

// ----- FLOW -----------------------------------------------------------------

function renderFlow() {
    const grid = $('#stageGrid');
    grid.innerHTML = '';
    state.flow.stages.forEach(stage => {
        const card = document.createElement('div');
        card.className = 'stage-card';
        card.dataset.stageId = stage.id;
        const fileLine = stage.files.map(f => shortPath(f.path)).join(' · ');
        card.innerHTML = `
            <span class="num">Stage ${stage.id}</span>
            <div class="title">${escapeHtml(stage.title)}</div>
            <div class="tagline">${escapeHtml(stage.tagline || '')}</div>
            <div class="files-line">${escapeHtml(fileLine)}</div>
        `;
        card.addEventListener('click', () => openStage(stage.id));
        grid.appendChild(card);
    });
}

async function renderDiagram() {
    const el = $('#diagram');
    const src = state.flow?.diagram?.mermaid;
    if (!src) {
        el.textContent = '(no diagram defined)';
        return;
    }
    try {
        // mermaid v11: render() returns {svg, bindFunctions}
        const { svg, bindFunctions } = await window.__mermaid.render('flowDiagram', src);
        el.innerHTML = svg;
        if (typeof bindFunctions === 'function') bindFunctions(el);
        // Make node labels containing "1 -" through "12 -" clickable to open the
        // corresponding stage card. Walks the rendered SVG.
        $$('g.node', el).forEach(g => {
            const txt = g.textContent || '';
            const m = txt.match(/^\s*(\d+)\b/);
            if (m) {
                const id = parseInt(m[1], 10);
                if (state.flow.stages.find(s => s.id === id)) {
                    g.style.cursor = 'pointer';
                    g.addEventListener('click', () => openStage(id));
                }
            }
        });
    } catch (err) {
        console.error('mermaid render failed', err);
        el.innerHTML = `<pre style="white-space:pre-wrap;color:#f0b46d">Diagram failed to render:\n${escapeHtml(err.message)}</pre>`;
    }
}

function openStage(id) {
    const stage = state.flow.stages.find(s => s.id === id);
    if (!stage) return;
    state.activeStageId = id;

    $('#drawerEyebrow').textContent = `Stage ${stage.id}`;
    $('#drawerTitle').textContent   = stage.title;
    $('#drawerTagline').textContent = stage.tagline || '';

    // Files
    const filesUl = $('#drawerFiles');
    filesUl.innerHTML = '';
    stage.files.forEach((f, idx) => {
        const li = document.createElement('li');
        const symbols = (f.symbols || []).join(', ');
        const lines = f.lines ? `lines ${escapeHtml(f.lines)}` : '';
        li.innerHTML = `
            <div class="row">
                <span class="path">${escapeHtml(f.path)}</span>
                <button class="open-btn" data-idx="${idx}">view</button>
            </div>
            ${symbols ? `<span class="symbols">${escapeHtml(symbols)}</span>` : ''}
            ${lines   ? `<span class="lines">${lines}</span>`           : ''}
        `;
        li.querySelector('.open-btn').addEventListener('click', () => openSourceFromFile(f));
        filesUl.appendChild(li);
    });

    // Notes
    const notesUl = $('#drawerNotes');
    notesUl.innerHTML = '';
    (stage.notes || []).forEach(note => {
        const li = document.createElement('li');
        li.textContent = note;
        notesUl.appendChild(li);
    });

    // Themes
    const themesEl = $('#drawerThemes');
    themesEl.innerHTML = '';
    (stage.improvementHooks || []).forEach(themeId => {
        const theme = state.research.themes.find(t => t.id === themeId);
        if (!theme) return;
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = theme.title;
        c.addEventListener('click', () => {
            closeDrawer();
            $('.tab[data-tab="research"]').click();
            // Scroll to that section.
            setTimeout(() => {
                const target = document.getElementById(`research-${themeId}`);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
        });
        themesEl.appendChild(c);
    });

    // Note text
    const key = noteKey('stage', id);
    $('#drawerNoteText').value = state.notes.byKey[key]?.text || '';
    $('#drawerNoteStatus').textContent = state.notes.byKey[key]
        ? `Saved ${new Date(state.notes.byKey[key].updatedAt).toLocaleString()}`
        : '';

    $('#stageDrawer').classList.add('open');
    $('#stageDrawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
    $('#stageDrawer').classList.remove('open');
    $('#stageDrawer').setAttribute('aria-hidden', 'true');
    state.activeStageId = null;
}

async function saveDrawerNote() {
    if (!state.activeStageId) return;
    const key = noteKey('stage', state.activeStageId);
    const text = $('#drawerNoteText').value;
    try {
        const r = await fetchJson(`/api/notes/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (r.entry) {
            state.notes.byKey[key] = r.entry;
            $('#drawerNoteStatus').textContent = `Saved ${new Date(r.entry.updatedAt).toLocaleString()}`;
        } else {
            delete state.notes.byKey[key];
            $('#drawerNoteStatus').textContent = 'Cleared';
        }
    } catch (err) {
        $('#drawerNoteStatus').textContent = 'Save failed: ' + err.message;
    }
}

function sendDrawerNoteToPlans() {
    if (!state.activeStageId) return;
    const stage = state.flow.stages.find(s => s.id === state.activeStageId);
    const text = $('#drawerNoteText').value.trim();
    const card = {
        id: uid(),
        title: `Stage ${stage.id}: ${stage.title}`,
        body: text || stage.tagline || '',
        status: 'backlog',
        tags: ['from-flow', `stage-${stage.id}`],
        sourceLink: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    state.plans.cards.push(card);
    persistPlans();
    renderPlans();
    $('#drawerNoteStatus').textContent = 'Sent to Plans';
}

// ----- SOURCE VIEWER --------------------------------------------------------

async function openSourceFromFile(file) {
    const lines = file.lines || '';
    let start = null, end = null;
    const m = lines.match(/(\d+)\s*-\s*(\d+)/);
    if (m) { start = parseInt(m[1], 10); end = parseInt(m[2], 10); }
    await openSource(file.path, start, end);
}

async function openSource(relPath, start, end) {
    $('#sourceLabel').textContent = relPath;
    $('#sourceMeta').textContent = start
        ? `lines ${start}–${end}`
        : 'full file';
    $('#sourceCode').innerHTML = '<code>loading…</code>';
    $('#sourceModal').classList.add('open');

    const url = new URL('/api/source', location.origin);
    url.searchParams.set('path', relPath);
    if (start) url.searchParams.set('start', String(start));
    if (end)   url.searchParams.set('end',   String(end));

    try {
        const data = await fetchJson(url.pathname + url.search);
        const startLine = data.start || 1;
        const code = data.content
            .split('\n')
            .map((ln, i) => `<span class="ln">${startLine + i}</span>${escapeHtml(ln)}`)
            .join('\n');
        $('#sourceCode').innerHTML = `<code>${code}</code>`;
        $('#sourceMeta').textContent =
            `lines ${data.start}–${data.end} of ${data.totalLines}`;
    } catch (err) {
        $('#sourceCode').innerHTML = `<code style="color:#f6707b">${escapeHtml(err.message)}</code>`;
    }
}

// ----- RESEARCH -------------------------------------------------------------

function renderResearch() {
    renderResearchNav();
    renderResearchBody();
}

function renderResearchNav() {
    const nav = $('#researchNav');
    nav.innerHTML = '';

    const sections = [
        { id: 'quick-wins', label: 'Quick wins' },
        ...state.research.themes.map(t => ({ id: t.id, label: t.title })),
        { id: 'bigger-bets', label: 'Bigger bets' }
    ];

    sections.forEach(sec => {
        const btn = document.createElement('button');
        btn.textContent = sec.label;
        btn.dataset.target = `research-${sec.id}`;
        btn.addEventListener('click', () => {
            $$('.research-nav button').forEach(b => b.classList.toggle('active', b === btn));
            const t = document.getElementById(btn.dataset.target);
            if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.appendChild(btn);
    });
}

function renderResearchBody() {
    const body = $('#researchBody');
    body.innerHTML = '';

    body.appendChild(renderResearchSection({
        id: 'quick-wins',
        title: 'Quick wins',
        summary: 'Five concrete changes you could ship in 1–3 days. Ranked by impact / effort.',
        recs: state.research.quick_wins,
        kind: 'quick'
    }));

    state.research.themes.forEach(theme => {
        body.appendChild(renderResearchSection({
            id: theme.id,
            title: theme.title,
            summary: theme.summary,
            recs: theme.recommendations,
            kind: 'theme'
        }));
    });

    body.appendChild(renderResearchSection({
        id: 'bigger-bets',
        title: 'Bigger bets',
        summary: 'Multi-week investments worth a design doc before kicking off.',
        recs: state.research.bigger_bets,
        kind: 'bet'
    }));
}

function renderResearchSection({ id, title, summary, recs, kind }) {
    const sec = document.createElement('section');
    sec.className = 'research-section';
    sec.id = `research-${id}`;
    sec.innerHTML = `
        <h2>${escapeHtml(title)}</h2>
        <p class="summary">${escapeHtml(summary || '')}</p>
    `;
    recs.forEach(rec => sec.appendChild(renderRecCard(rec, kind)));
    return sec;
}

function renderRecCard(rec, kind) {
    const card = document.createElement('div');
    card.className = 'rec-card';

    const impact = rec.impact ? `<span class="badge ${rec.impact}">${escapeHtml(rec.impact)} impact</span>` : '';
    const effort = rec.effort ? `<span class="badge effort">${escapeHtml(rec.effort)} effort</span>` : '';
    const detailText = rec.detail || rec.summary || rec.rationale || '';

    const linksHtml = (rec.links || []).map(href =>
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(prettyLink(href))}</a>`).join(' ');

    const touchesHtml = (rec.touches || []).map(t =>
        `<span class="touch">${escapeHtml(t)}</span>`).join('');

    const noteKeyVal = noteKey('rec', rec.id);
    const existingNote = state.notes.byKey[noteKeyVal]?.text || '';

    card.innerHTML = `
        <div class="rec-head">
            <div>
                <div class="rec-title">${escapeHtml(rec.title)}</div>
                <div class="rec-detail">${escapeHtml(detailText)}</div>
            </div>
            <div class="rec-actions">
                ${impact} ${effort}
            </div>
        </div>
        <div class="rec-meta">${touchesHtml}</div>
        <div class="rec-meta links">${linksHtml}</div>
        <div class="rec-notes-box">
            <textarea data-note-key="${escapeHtml(noteKeyVal)}" placeholder="Notes / decisions for this recommendation…">${escapeHtml(existingNote)}</textarea>
            <div class="note-row">
                <button class="btn ghost" data-action="save-rec-note" data-note-key="${escapeHtml(noteKeyVal)}">Save note</button>
                <button class="btn primary" data-action="rec-to-plan">Add to Plans</button>
                <span class="note-status" data-note-status="${escapeHtml(noteKeyVal)}">${existingNote ? 'Saved' : ''}</span>
            </div>
        </div>
    `;

    card.querySelector('[data-action="save-rec-note"]').addEventListener('click', async () => {
        const ta = card.querySelector('textarea');
        const text = ta.value;
        try {
            const r = await fetchJson(`/api/notes/${encodeURIComponent(noteKeyVal)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (r.entry) state.notes.byKey[noteKeyVal] = r.entry;
            else delete state.notes.byKey[noteKeyVal];
            card.querySelector(`[data-note-status="${noteKeyVal}"]`).textContent =
                r.entry ? `Saved ${new Date(r.entry.updatedAt).toLocaleString()}` : 'Cleared';
        } catch (err) {
            card.querySelector(`[data-note-status="${noteKeyVal}"]`).textContent = 'Save failed';
        }
    });

    card.querySelector('[data-action="rec-to-plan"]').addEventListener('click', () => {
        const ta = card.querySelector('textarea');
        const tagBase = (kind === 'quick') ? 'quick-win' : (kind === 'bet') ? 'bigger-bet' : 'recommendation';
        const newCard = {
            id: uid(),
            title: rec.title,
            body: (ta.value.trim() ? (ta.value.trim() + '\n\n---\n') : '')
                  + detailText
                  + ((rec.touches || []).length ? `\n\nTouches: ${rec.touches.join(', ')}` : '')
                  + ((rec.links || []).length ? `\nLinks:\n- ${rec.links.join('\n- ')}` : ''),
            status: 'backlog',
            tags: [tagBase, ...(rec.touches || []).slice(0, 2).map(slugify)],
            sourceLink: rec.links?.[0] || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        state.plans.cards.push(newCard);
        persistPlans();
        renderPlans();
        const status = card.querySelector(`[data-note-status="${noteKeyVal}"]`);
        status.textContent = 'Added to Plans';
    });

    return card;
}

function prettyLink(href) {
    try {
        const u = new URL(href);
        return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
    } catch {
        return href;
    }
}

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

// ----- PLANS / KANBAN -------------------------------------------------------

function renderPlans() {
    $$('.column .cards').forEach(c => c.innerHTML = '');
    const byStatus = { backlog: [], planned: [], inprogress: [], done: [] };
    state.plans.cards.forEach(c => {
        if (!byStatus[c.status]) c.status = 'backlog';
        byStatus[c.status].push(c);
    });
    Object.entries(byStatus).forEach(([status, cards]) => {
        const wrap = $(`.column[data-status="${status}"] .cards`);
        cards.forEach(c => wrap.appendChild(renderKCard(c)));
    });
    bindKanbanDnD();
    $('#plansStatus').textContent =
        state.plans.updatedAt
            ? `Last saved ${new Date(state.plans.updatedAt).toLocaleString()}`
            : '';
}

function renderKCard(c) {
    const el = document.createElement('div');
    el.className = 'kcard';
    el.draggable = true;
    el.dataset.id = c.id;
    const tags = (c.tags || []).map(t => `<span class="ktag">${escapeHtml(t)}</span>`).join('');
    el.innerHTML = `
        <div class="ktitle">${escapeHtml(c.title)}</div>
        <div class="kbody">${escapeHtml((c.body || '').slice(0, 240))}</div>
        <div class="ktags">${tags}</div>
    `;
    el.addEventListener('click', () => openCardModal(c.id));
    el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', c.id);
        e.dataTransfer.effectAllowed = 'move';
    });
    return el;
}

function bindKanbanDnD() {
    $$('.column').forEach(col => {
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            col.classList.add('drop-target');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
        col.addEventListener('drop', (e) => {
            e.preventDefault();
            col.classList.remove('drop-target');
            const id = e.dataTransfer.getData('text/plain');
            const card = state.plans.cards.find(c => c.id === id);
            if (!card) return;
            card.status = col.dataset.status;
            card.updatedAt = new Date().toISOString();
            persistPlans();
            renderPlans();
        });
    });
}

function openCardModal(id) {
    state.cardEditId = id;
    let card;
    if (id) {
        card = state.plans.cards.find(c => c.id === id);
        if (!card) return;
        $('#cardModalMeta').textContent =
            `Created ${new Date(card.createdAt).toLocaleString()}`;
        $('#cardDelete').style.display = '';
    } else {
        card = { title: '', body: '', status: 'backlog', tags: [] };
        $('#cardModalMeta').textContent = 'New card';
        $('#cardDelete').style.display = 'none';
    }
    $('#cardTitle').value  = card.title || '';
    $('#cardBody').value   = card.body  || '';
    $('#cardStatus').value = card.status || 'backlog';
    $('#cardTags').value   = (card.tags || []).join(', ');
    $('#cardModal').classList.add('open');
    setTimeout(() => $('#cardTitle').focus(), 50);
}

function closeCardModal() {
    $('#cardModal').classList.remove('open');
    state.cardEditId = null;
}

function saveCardModal() {
    const title = $('#cardTitle').value.trim();
    if (!title) { $('#cardTitle').focus(); return; }
    const body   = $('#cardBody').value;
    const status = $('#cardStatus').value;
    const tags   = $('#cardTags').value.split(',').map(s => s.trim()).filter(Boolean);

    if (state.cardEditId) {
        const c = state.plans.cards.find(c => c.id === state.cardEditId);
        if (!c) return closeCardModal();
        c.title = title; c.body = body; c.status = status; c.tags = tags;
        c.updatedAt = new Date().toISOString();
    } else {
        state.plans.cards.push({
            id: uid(),
            title, body, status, tags,
            sourceLink: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    persistPlans();
    renderPlans();
    closeCardModal();
}

function deleteCardModal() {
    if (!state.cardEditId) return;
    state.plans.cards = state.plans.cards.filter(c => c.id !== state.cardEditId);
    persistPlans();
    renderPlans();
    closeCardModal();
}

const persistPlans = debounce(async () => {
    try {
        const r = await fetchJson('/api/plans', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards: state.plans.cards })
        });
        state.plans.updatedAt = r.updatedAt;
        $('#plansStatus').textContent = `Saved ${new Date(r.updatedAt).toLocaleString()}`;
    } catch (err) {
        $('#plansStatus').textContent = 'Save failed: ' + err.message;
    }
}, 250);

// ----- DRIFT ----------------------------------------------------------------

function renderDrift() {
    const ul = $('#driftList');
    ul.innerHTML = '';
    (state.flow.doc_drift || []).forEach(d => {
        const li = document.createElement('li');
        li.textContent = d;
        ul.appendChild(li);
    });
}
