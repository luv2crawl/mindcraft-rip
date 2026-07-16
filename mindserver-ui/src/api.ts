import type { SessionSummary, TranscriptEvent } from './types';

export async function fetchBots(): Promise<{ ok: boolean; bots: string[]; forbidden: boolean }> {
    const r = await fetch('/api/bots');
    if (r.status === 403) return { ok: false, bots: [], forbidden: true };
    if (!r.ok) return { ok: false, bots: [], forbidden: false };
    const j = (await r.json()) as { bots?: string[] };
    return { ok: true, bots: j.bots ?? [], forbidden: false };
}

export async function fetchSessions(bot: string): Promise<{ sessions: SessionSummary[] }> {
    const r = await fetch(`/api/bots/${encodeURIComponent(bot)}/sessions`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

export type EventsPageParams = {
    stage?: string;
    since?: string;
    until?: string;
    event_regex?: string;
    limit?: number;
    skip?: number;
};

export async function fetchTranscriptPage(
    bot: string,
    sessionId: string,
    debug: boolean,
    params: EventsPageParams,
): Promise<{
    events: TranscriptEvent[];
    has_more: boolean;
    next_skip: number;
}> {
    const q = new URLSearchParams();
    if (params.stage) q.set('stage', params.stage);
    if (params.since) q.set('since', params.since);
    if (params.until) q.set('until', params.until);
    if (params.event_regex) q.set('event_regex', params.event_regex);
    q.set('limit', String(params.limit ?? 400));
    q.set('skip', String(params.skip ?? 0));
    const path = debug
        ? `/api/bots/${encodeURIComponent(bot)}/sessions/${encodeURIComponent(sessionId)}/debug/events`
        : `/api/bots/${encodeURIComponent(bot)}/sessions/${encodeURIComponent(sessionId)}/events`;
    const r = await fetch(`${path}?${q}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

export async function fetchSettingsSpec(): Promise<Record<string, { type: string; default: unknown; description?: string }>> {
    const r = await fetch('/settings_spec.json');
    if (!r.ok) throw new Error('settings_spec.json');
    return r.json();
}

export type FileEntry = { name: string; type: 'dir' | 'file'; size: number | null; mtime: string };

export async function fetchBotFiles(bot: string, relPath: string): Promise<{ entries: FileEntry[] }> {
    const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
    const r = await fetch(`/api/bots/${encodeURIComponent(bot)}/files${q}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

export function workspaceFileUrl(relPath: string): string {
    return `/api/workspace/file?path=${encodeURIComponent(relPath)}`;
}
