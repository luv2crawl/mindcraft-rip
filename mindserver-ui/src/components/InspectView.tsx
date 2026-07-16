import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBotFiles, fetchBots, fetchSessions, fetchTranscriptPage } from '../api';
import { getSocket } from '../socket';
import type { SessionSummary, TranscriptEvent } from '../types';
import { enrichEventsWithTurns, isFailureEvent } from '../transcript/turns';
import { INSPECT_STAGE_ORDER, PRESETS, type InspectPresetId } from '../transcript/presets';
import {
    eventKey,
    eventMatchesAppliedFilters,
    matchesInspectSearch,
    presetDisplayName,
} from '../transcript/inspectHelpers';
import { EventInspector } from './EventInspector';
import { EventTimeline } from './EventTimeline';
import { readUrlParams, setUrlParams } from '../utils/urlParams';
import styles from './InspectView.module.css';

type AppliedFilters = {
    preset: InspectPresetId;
    customRegex: string;
    stages: string[];
    since: string;
    until: string;
};

const DEFAULT_FILTERS: AppliedFilters = {
    preset: 'human_loop',
    customRegex: '',
    stages: [],
    since: '',
    until: '',
};

function resolvePreset(id: InspectPresetId) {
    return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

function buildApiQuery(opts: AppliedFilters): { stage?: string; event_regex?: string; since?: string; until?: string } {
    const preset = resolvePreset(opts.preset);
    const parts: string[] = [];
    if (preset.eventRegex) parts.push(`(?:${preset.eventRegex})`);
    if (opts.customRegex.trim()) parts.push(`(?:${opts.customRegex.trim()})`);
    const event_regex = parts.length ? parts.join('|') : undefined;

    let stage: string | undefined;
    if (opts.stages.length) {
        stage = opts.stages.join(',');
    } else if (preset.stages?.length) {
        stage = preset.stages.join(',');
    }

    return {
        stage,
        event_regex,
        since: opts.since.trim() || undefined,
        until: opts.until.trim() || undefined,
    };
}

function formatDuration(ms: number | null): string {
    if (ms == null) return 'open';
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.round(ms / 1000);
    if (sec < 90) return `${sec}s`;
    return `${Math.round(sec / 60)}m`;
}

function formatSessionLabel(session: SessionSummary): string {
    const tail = session.id.length > 34 ? session.id.slice(-34) : session.id;
    return `${tail} (${session.error_count} err, ${formatDuration(session.duration_ms)})`;
}

export function InspectView() {
    const [bots, setBots] = useState<string[]>([]);
    const [bot, setBot] = useState(() => readUrlParams().bot ?? '');
    const [sessionId, setSessionId] = useState<string | null>(() => readUrlParams().session);

    const [preset, setPreset] = useState<InspectPresetId>(DEFAULT_FILTERS.preset);
    const [customRegex, setCustomRegex] = useState(DEFAULT_FILTERS.customRegex);
    const [stages, setStages] = useState<string[]>(DEFAULT_FILTERS.stages);
    const [since, setSince] = useState(DEFAULT_FILTERS.since);
    const [until, setUntil] = useState(DEFAULT_FILTERS.until);
    const [applied, setApplied] = useState<AppliedFilters>(DEFAULT_FILTERS);

    const [searchQuery, setSearchQuery] = useState('');
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [useDebug, setUseDebug] = useState(false);
    const [liveTail, setLiveTail] = useState(false);
    const [collapseNoisy, setCollapseNoisy] = useState(true);
    const [events, setEvents] = useState<TranscriptEvent[]>([]);
    const [nextSkip, setNextSkip] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loadingEvents, setLoadingEvents] = useState(false);
    const loadingRef = useRef(false);
    const [loadStatus, setLoadStatus] = useState('');
    const [selected, setSelected] = useState<TranscriptEvent | null>(null);
    const [failureIx, setFailureIx] = useState(-1);
    const [fileOpen, setFileOpen] = useState(false);
    const [filePath, setFilePath] = useState('');

    useEffect(() => {
        void fetchBots().then((r) => {
            setBots(r.bots);
            const urlBot = readUrlParams().bot;
            if (urlBot && r.bots.includes(urlBot)) {
                setBot(urlBot);
                return;
            }
            setBot((current) => (current && r.bots.includes(current) ? current : r.bots[0] ?? ''));
        });
    }, []);

    useEffect(() => {
        setUrlParams({ bot: bot || null, session: sessionId });
    }, [bot, sessionId]);

    const sessionsQuery = useQuery({
        queryKey: ['sessions', bot],
        queryFn: () => fetchSessions(bot),
        enabled: Boolean(bot),
    });
    const sessions = sessionsQuery.data?.sessions ?? [];
    const activeSession = sessions.find((s) => s.id === sessionId) ?? null;
    const sessionsError = sessionsQuery.isError ? sessionsQuery.error : null;

    useEffect(() => {
        const sid = readUrlParams().session;
        if (sid && sessions.some((s) => s.id === sid)) {
            setSessionId(sid);
            return;
        }
        setSessionId((current) => {
            if (current && sessions.some((s) => s.id === current)) return current;
            return sessions[0]?.id ?? null;
        });
    }, [sessions]);

    const loadFirstPage = useCallback(async () => {
        if (!bot || !sessionId) {
            setEvents([]);
            setLoadStatus('');
            return;
        }

        loadingRef.current = true;
        setLoadingEvents(true);
        setLoadStatus('Loading...');
        const q = buildApiQuery(applied);
        try {
            const js = await fetchTranscriptPage(bot, sessionId, useDebug, { ...q, limit: 400, skip: 0 });
            const chunk = js.events ?? [];
            setEvents(chunk);
            setNextSkip(js.next_skip ?? chunk.length);
            setHasMore(Boolean(js.has_more));
            setLoadStatus(`${chunk.length} loaded${js.has_more ? ', more available' : ''}`);
        } catch (e) {
            setEvents([]);
            setNextSkip(0);
            setHasMore(false);
            setLoadStatus(String(e instanceof Error ? e.message : e));
        } finally {
            loadingRef.current = false;
            setLoadingEvents(false);
        }
    }, [bot, sessionId, useDebug, applied]);

    useEffect(() => {
        void loadFirstPage();
    }, [loadFirstPage]);

    const enriched = useMemo(() => enrichEventsWithTurns(events), [events]);
    const visibleEvents = useMemo(
        () => enriched.filter((ev) => matchesInspectSearch(ev, searchQuery)),
        [enriched, searchQuery],
    );
    const failures = useMemo(() => visibleEvents.filter((e) => isFailureEvent(e)), [visibleEvents]);

    useEffect(() => {
        if (loadingEvents) return;
        if (!visibleEvents.length) {
            setSelected(null);
            return;
        }
        setSelected((current) => {
            if (current && visibleEvents.some((ev) => eventKey(ev) === eventKey(current))) return current;
            if (applied.preset === 'errors_only') return failures[0] ?? visibleEvents[0];
            return visibleEvents[0];
        });
    }, [applied.preset, failures, loadingEvents, visibleEvents]);

    useEffect(() => {
        const socket = getSocket();
        const onLive = (payload: {
            agent: string;
            sessionId: string;
            entry: TranscriptEvent;
            debug: boolean;
        }) => {
            if (!liveTail) return;
            if (payload.agent !== bot) return;
            if (payload.sessionId !== sessionId) return;
            if (Boolean(payload.debug) !== useDebug) return;

            const q = buildApiQuery(applied);
            const stageList = q.stage ? q.stage.split(',') : null;
            if (!eventMatchesAppliedFilters(payload.entry, stageList, q.event_regex ?? null, q.since, q.until)) return;

            setEvents((prev) =>
                prev.concat([
                    {
                        ...payload.entry,
                        line: '.',
                        _live: true,
                    },
                ]),
            );
        };
        socket.on('transcript-event', onLive);
        return () => {
            socket.off('transcript-event', onLive);
        };
    }, [liveTail, bot, sessionId, useDebug, applied]);

    const selectSession = useCallback((id: string) => {
        setSessionId(id);
        setUrlParams({ session: id });
    }, []);

    const onPresetChange = useCallback(
        (next: InspectPresetId) => {
            setPreset(next);
            setApplied((current) => ({ ...current, preset: next }));
        },
        [],
    );

    const applyFilters = useCallback(() => {
        setApplied({
            preset,
            customRegex,
            stages: [...stages],
            since,
            until,
        });
    }, [preset, customRegex, stages, since, until]);

    const loadMore = useCallback(async () => {
        if (!hasMore || !bot || !sessionId || loadingRef.current) return;
        loadingRef.current = true;
        setLoadingEvents(true);
        setLoadStatus('Loading...');
        const q = buildApiQuery(applied);
        try {
            const js = await fetchTranscriptPage(bot, sessionId, useDebug, {
                ...q,
                limit: 400,
                skip: nextSkip,
            });
            const chunk = js.events ?? [];
            setEvents((prev) => {
                const next = prev.concat(chunk);
                setLoadStatus(`${next.length} loaded${js.has_more ? ', more available' : ''}`);
                return next;
            });
            setNextSkip(js.next_skip ?? nextSkip + chunk.length);
            setHasMore(Boolean(js.has_more));
        } catch (e) {
            setLoadStatus(String(e instanceof Error ? e.message : e));
        } finally {
            loadingRef.current = false;
            setLoadingEvents(false);
        }
    }, [hasMore, bot, sessionId, useDebug, applied, nextSkip]);

    const jumpFailure = useCallback(() => {
        if (!failures.length) return;
        const next = (failureIx + 1) % failures.length;
        setFailureIx(next);
        setSelected(failures[next]);
    }, [failures, failureIx]);

    const workflowContext = useCallback(() => {
        const ev = selected;
        if (!ev?.ts) return;
        const t = new Date(ev.ts).getTime();
        if (Number.isNaN(t)) return;
        const start = new Date(t - 30_000).toISOString();
        const end = new Date(t + 30_000).toISOString();
        setSince(start);
        setUntil(end);
        setApplied((current) => ({ ...current, since: start, until: end }));
    }, [selected]);

    const exportNdjson = useCallback(() => {
        const lines = visibleEvents.map((e) => JSON.stringify(e)).join('\n');
        const blob = new Blob([lines], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${bot || 'bot'}-${sessionId || 'session'}-export.jsonl`;
        a.click();
        URL.revokeObjectURL(url);
    }, [visibleEvents, bot, sessionId]);

    function toggleStage(stage: string) {
        setStages((prev) => (prev.includes(stage) ? prev.filter((item) => item !== stage) : [...prev, stage]));
    }

    return (
        <div className={styles.root}>
            <div className={styles.toolbar}>
                <label className={styles.control}>
                    <span>Bot</span>
                    <select value={bot} onChange={(e) => setBot(e.target.value)} disabled={!bots.length}>
                        {bots.length ? (
                            bots.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))
                        ) : (
                            <option value="">No bots</option>
                        )}
                    </select>
                </label>

                <label className={styles.controlWide}>
                    <span>Session</span>
                    <select
                        value={sessionId ?? ''}
                        onChange={(e) => selectSession(e.target.value)}
                        disabled={!sessions.length}
                    >
                        {sessions.length ? (
                            sessions.map((session) => (
                                <option key={session.id} value={session.id}>
                                    {formatSessionLabel(session)}
                                </option>
                            ))
                        ) : (
                            <option value="">No sessions</option>
                        )}
                    </select>
                </label>

                <label className={styles.control}>
                    <span>Preset</span>
                    <select value={preset} onChange={(e) => onPresetChange(e.target.value as InspectPresetId)}>
                        {PRESETS.map((item) => (
                            <option key={item.id} value={item.id}>
                                {presetDisplayName(item.id)}
                            </option>
                        ))}
                    </select>
                </label>

                <label className={styles.searchControl}>
                    <span>Search</span>
                    <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="event, text, trace, line"
                    />
                </label>

                <button type="button" className={styles.button} onClick={() => setAdvancedOpen((open) => !open)}>
                    Advanced
                </button>
                <button
                    type="button"
                    className={liveTail ? styles.buttonActive : styles.button}
                    onClick={() => setLiveTail((value) => !value)}
                    aria-pressed={liveTail}
                >
                    Live
                </button>
                <button type="button" className={styles.button} onClick={exportNdjson} disabled={!visibleEvents.length}>
                    Export
                </button>
            </div>

            {advancedOpen ? (
                <section className={styles.advancedDrawer} aria-label="Advanced filters">
                    <div className={styles.advancedGrid}>
                        <label className={styles.controlWide}>
                            <span>Event regex</span>
                            <input
                                value={customRegex}
                                onChange={(e) => setCustomRegex(e.target.value)}
                                placeholder="e.g. model\\."
                            />
                        </label>
                        <label className={styles.controlWide}>
                            <span>Since</span>
                            <input value={since} onChange={(e) => setSince(e.target.value)} placeholder="ISO timestamp" />
                        </label>
                        <label className={styles.controlWide}>
                            <span>Until</span>
                            <input value={until} onChange={(e) => setUntil(e.target.value)} placeholder="ISO timestamp" />
                        </label>
                        <label className={styles.checkControl}>
                            <input type="checkbox" checked={useDebug} onChange={(e) => setUseDebug(e.target.checked)} />
                            <span>Debug JSONL</span>
                        </label>
                        <label className={styles.checkControl}>
                            <input
                                type="checkbox"
                                checked={collapseNoisy}
                                onChange={(e) => setCollapseNoisy(e.target.checked)}
                            />
                            <span>Collapse noisy</span>
                        </label>
                    </div>

                    <div className={styles.stageGroup}>
                        <div className={styles.groupLabel}>Stage override</div>
                        <div className={styles.stageList}>
                            {INSPECT_STAGE_ORDER.map((stage) => (
                                <label key={stage} className={styles.stageCheck}>
                                    <input
                                        type="checkbox"
                                        checked={stages.includes(stage)}
                                        onChange={() => toggleStage(stage)}
                                    />
                                    <span>{stage}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={styles.drawerActions}>
                        <button type="button" className={styles.primaryButton} onClick={applyFilters}>
                            Apply filters
                        </button>
                        <button type="button" className={styles.button} onClick={workflowContext} disabled={!selected?.ts}>
                            Workflow context
                        </button>
                        <button type="button" className={styles.button} onClick={() => setFileOpen((value) => !value)}>
                            {fileOpen ? 'Hide files' : 'File browser'}
                        </button>
                        <button type="button" className={styles.button} onClick={() => void fetchBots().then((r) => setBots(r.bots))}>
                            Refresh bots
                        </button>
                    </div>

                    <details className={styles.stageReference}>
                        <summary>Workflow stage reference</summary>
                        <StageRefTable />
                    </details>

                    {fileOpen ? <FileBrowserInline bot={bot} relPath={filePath} onNavigate={setFilePath} /> : null}
                </section>
            ) : null}

            {sessionsError ? (
                <div className={styles.errorBanner}>
                    Could not load sessions: {String(sessionsError instanceof Error ? sessionsError.message : sessionsError)}
                </div>
            ) : null}

            <div className={styles.readerGrid}>
                <SessionRail
                    sessions={sessions}
                    activeId={sessionId}
                    loading={sessionsQuery.isLoading}
                    onSelect={selectSession}
                />

                <main className={styles.traceColumn}>
                    <div className={styles.timelineHeader}>
                        <div>
                            <h1>Trace reader</h1>
                            <p>
                                {activeSession ? formatSessionLabel(activeSession) : 'Choose a session'}.
                                {' '}
                                {visibleEvents.length} shown from {events.length} loaded.
                            </p>
                        </div>
                        <div className={styles.timelineActions}>
                            <button
                                type="button"
                                className={styles.button}
                                onClick={jumpFailure}
                                disabled={!failures.length}
                            >
                                Jump to failure
                            </button>
                            <button type="button" className={styles.button} onClick={() => void loadMore()} disabled={!hasMore}>
                                Load more
                            </button>
                        </div>
                    </div>

                    {!sessionId && bot ? (
                        <div className={styles.timelineEmpty}>
                            <div className={styles.emptyTitle}>No transcript sessions</div>
                            <p>Start the agent with transcript logging enabled, then refresh bots.</p>
                        </div>
                    ) : (
                        <EventTimeline
                            events={visibleEvents}
                            selected={selected}
                            onSelect={setSelected}
                            preset={applied.preset}
                            collapseNoisy={collapseNoisy}
                            emptyHint={
                                sessionId && !visibleEvents.length && !loadingEvents
                                    ? 'No loaded events match the current filters or search.'
                                    : undefined
                            }
                        />
                    )}

                    <div className={styles.statusLine}>
                        <span>{loadStatus || (loadingEvents ? 'Loading...' : 'Ready')}</span>
                        {useDebug ? <span>Debug source</span> : <span>Transcript source</span>}
                        {liveTail ? <span>Live tail on</span> : null}
                    </div>
                </main>

                <EventInspector ev={selected} />
            </div>
        </div>
    );
}

function SessionRail({
    sessions,
    activeId,
    onSelect,
    loading,
}: {
    sessions: SessionSummary[];
    activeId: string | null;
    onSelect: (id: string) => void;
    loading: boolean;
}) {
    if (loading) {
        return (
            <aside className={styles.sessionRail}>
                <div className={styles.railHeader}>Sessions</div>
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLineShort} />
            </aside>
        );
    }
    if (!sessions.length) {
        return (
            <aside className={styles.sessionRail}>
                <div className={styles.railHeader}>Sessions</div>
                <p className={styles.railEmpty}>No JSONL sessions for this bot.</p>
            </aside>
        );
    }
    return (
        <aside className={styles.sessionRail}>
            <div className={styles.railHeader}>Sessions</div>
            <div className={styles.sessionList}>
                {sessions.map((session) => {
                    const active = session.id === activeId;
                    return (
                        <button
                            key={session.id}
                            type="button"
                            className={active ? styles.sessionItemActive : styles.sessionItem}
                            onClick={() => onSelect(session.id)}
                        >
                            <span className={styles.sessionName}>{session.id}</span>
                            <span className={styles.sessionMeta}>
                                <span className={session.error_count ? styles.errorPill : styles.okPill}>
                                    {session.error_count} err
                                </span>
                                <span>{formatDuration(session.duration_ms)}</span>
                                {session.debug_available ? <span>debug</span> : null}
                            </span>
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}

function StageRefTable() {
    const rows: [string, string, string][] = [
        ['system', 'process lifecycle', 'agent.start, agent.spawn, agent.shutdown'],
        ['connection', 'server connection', 'agent.login, connection.kicked'],
        ['inbound', 'message arrives', 'message.handle.*, message.prompt.input'],
        ['memory', 'memory and world', 'memory.*, world_memory.*'],
        ['prompt', 'assembly', 'prompt.assemble.*'],
        ['model', 'LLM', 'model.request, model.response, model.error'],
        ['command', 'command dispatch', 'command.parsed, command.start'],
        ['action', 'action manager', 'action.start, action.end'],
        ['objective', 'objective stack', 'objective.*'],
        ['mode', 'modes.js', 'mode.trigger'],
        ['loop', 'self-prompter', 'self_prompter.*'],
        ['pathfinder', 'movement', 'pathfinder.*'],
        ['outbound', 'bot speaks', 'message.outbound'],
    ];
    return (
        <table className={styles.stageTable}>
            <thead>
                <tr>
                    <th>Stage</th>
                    <th>Phase</th>
                    <th>Events</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(([stage, phase, events]) => (
                    <tr key={stage}>
                        <td>
                            <code>{stage}</code>
                        </td>
                        <td>{phase}</td>
                        <td>
                            <code>{events}</code>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function FileBrowserInline({
    bot,
    relPath,
    onNavigate,
}: {
    bot: string;
    relPath: string;
    onNavigate: (p: string) => void;
}) {
    const q = useQuery({
        queryKey: ['botFiles', bot, relPath],
        queryFn: () => fetchBotFiles(bot, relPath),
        enabled: Boolean(bot),
    });
    const entries = q.data?.entries ?? [];
    const parentPath = relPath.split('/').slice(0, -1).join('/');

    return (
        <div className={styles.fileBrowser}>
            <div className={styles.filePath}>bots/{bot}/{relPath ? relPath.replace(/\\/g, '/') : ''}</div>
            {relPath ? (
                <button type="button" className={styles.fileRow} onClick={() => onNavigate(parentPath)}>
                    .. parent
                </button>
            ) : null}
            {q.isLoading ? <div className={styles.fileStatus}>Loading files...</div> : null}
            {entries.map((entry) => (
                <button
                    key={entry.name}
                    type="button"
                    className={styles.fileRow}
                    onClick={() => {
                        const base = relPath ? `${relPath.replace(/\\/g, '/')}/` : '';
                        const next = base + entry.name;
                        if (entry.type === 'dir') onNavigate(next);
                        else window.open(`/api/bots/${encodeURIComponent(bot)}/file?path=${encodeURIComponent(next)}`, '_blank');
                    }}
                >
                    <span>{entry.type === 'dir' ? 'dir' : 'file'}</span>
                    <strong>{entry.name}</strong>
                </button>
            ))}
        </div>
    );
}
