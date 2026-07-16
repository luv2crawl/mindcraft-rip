import type { TranscriptEvent } from '../types';
import { eventLane, isFailureEvent } from './turns';

export type InspectField = {
    label: string;
    value: string;
};

export type InspectSection = {
    title: string;
    content: string;
    tone?: 'default' | 'error';
    defaultOpen?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function stringifyValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value == null) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function firstString(data: Record<string, unknown> | null, keys: string[]): string | null {
    if (!data) return null;
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return null;
}

function compactText(value: string, max = 150): string {
    const s = value.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

export function eventKey(ev: TranscriptEvent | null): string {
    if (!ev) return '';
    return `${String(ev.line)}|${ev.ts ?? ''}|${ev.event ?? ''}`;
}

export function presetDisplayName(id: string): string {
    if (id === 'human_loop') return 'Story';
    if (id === 'debug_noise') return 'Debug-heavy';
    if (id === 'errors_only') return 'Errors';
    if (id === 'all') return 'Raw';
    return id.charAt(0).toUpperCase() + id.slice(1);
}

export function summarizeEvent(ev: TranscriptEvent): string {
    const name = ev.event ?? '(event)';
    const lane = eventLane(ev);
    const data = asRecord(ev.data);
    const detail = firstString(data, [
        'message',
        'text',
        'content',
        'command',
        'action',
        'goal',
        'reason',
        'error',
        'status',
        'path',
        'username',
        'sender',
    ]);

    if (name === 'message.handle.start') {
        return detail ? `Inbound message: ${compactText(detail)}` : 'Inbound message started';
    }
    if (name === 'message.outbound') {
        return detail ? `Outbound reply: ${compactText(detail)}` : 'Outbound message sent';
    }
    if (name === 'model.request') {
        const model = firstString(data, ['model', 'provider']);
        return model ? `Model request to ${model}` : 'Model request sent';
    }
    if (name === 'model.response') {
        const text = firstString(data, ['response', 'text', 'content', 'output']);
        return text ? `Model response: ${compactText(text)}` : 'Model response received';
    }
    if (name === 'model.error') {
        return detail ? `Model error: ${compactText(detail)}` : 'Model error';
    }
    if (name.startsWith('command.')) {
        return detail ? `Command ${name.split('.')[1] ?? 'event'}: ${compactText(detail)}` : `Command ${name.split('.')[1] ?? 'event'}`;
    }
    if (name.startsWith('action.')) {
        return detail ? `Action ${name.split('.')[1] ?? 'event'}: ${compactText(detail)}` : `Action ${name.split('.')[1] ?? 'event'}`;
    }
    if (name.startsWith('memory.') || lane === 'memory') {
        return detail ? `Memory update: ${compactText(detail)}` : 'Memory event';
    }
    if (name.startsWith('pathfinder.') || lane === 'pathfinder') {
        return detail ? `Movement: ${compactText(detail)}` : 'Movement event';
    }
    if (isFailureEvent(ev)) {
        return detail ? `Failure: ${compactText(detail)}` : 'Failure event';
    }
    return detail ? compactText(detail) : `${presetDisplayName(lane)} event`;
}

export function matchesInspectSearch(ev: TranscriptEvent, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
        ev.event,
        ev.stage,
        ev.ts,
        ev.line,
        ev.source,
        ev.trace_id,
        summarizeEvent(ev),
        stringifyValue(ev.data),
    ]
        .filter((v) => v !== undefined && v !== null)
        .join('\n')
        .toLowerCase();
    return haystack.includes(q);
}

export function eventMatchesAppliedFilters(
    ev: TranscriptEvent,
    stageList: string[] | null,
    eventRegex: string | null,
    since?: string,
    until?: string,
): boolean {
    if (stageList?.length && !stageList.includes(eventLane(ev))) return false;
    if (since && ev.ts && ev.ts < since) return false;
    if (until && ev.ts && ev.ts > until) return false;
    if (eventRegex) {
        try {
            const re = new RegExp(eventRegex);
            if (!re.test(ev.event ?? '')) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export function extractStack(ev: TranscriptEvent | null): string {
    const data = asRecord(ev?.data);
    if (!data) return '';
    if (typeof data.stack === 'string') return data.stack;
    const err = asRecord(data.error);
    if (typeof err?.stack === 'string') return err.stack;
    if (typeof data.source === 'string') return data.source;
    return '';
}

export function extractInspectorFields(ev: TranscriptEvent): InspectField[] {
    const data = asRecord(ev.data);
    const fields: InspectField[] = [];
    const add = (label: string, value: unknown) => {
        const text = stringifyValue(value);
        if (text) fields.push({ label, value: compactText(text, 180) });
    };

    add('event', ev.event);
    add('stage', eventLane(ev));
    add('line', ev.line);
    add('timestamp', ev.ts);
    add('trace', ev.trace_id);
    add('source', ev.source);

    if (data) {
        for (const key of ['model', 'provider', 'command', 'action', 'status', 'reason', 'username', 'sender']) {
            add(key, data[key]);
        }
    }

    return fields;
}

export function extractInspectorSections(ev: TranscriptEvent): InspectSection[] {
    const data = asRecord(ev.data);
    const sections: InspectSection[] = [];
    const add = (title: string, value: unknown, defaultOpen = true, tone: InspectSection['tone'] = 'default') => {
        const content = stringifyValue(value);
        if (content.trim()) sections.push({ title, content, defaultOpen, tone });
    };

    if (data) {
        if (ev.event === 'model.request') {
            add('Prompt', data.prompt);
            add('Messages', data.messages);
        }
        if (ev.event === 'model.response') {
            add('Response', data.response ?? data.text ?? data.content ?? data.output);
            add('Raw model payload', data.raw, false);
        }
        if (ev.event === 'model.error') {
            add('Error', data.error ?? data.message ?? data.reason, true, 'error');
            add('Response', data.response, false);
            add('Raw model payload', data.raw, false);
        }
        if (ev.event?.startsWith('command.')) {
            add('Command payload', data.command ?? data.args ?? data);
        }
        if (ev.event?.startsWith('action.')) {
            add('Action payload', data.action ?? data.result ?? data);
        }
        if (ev.event?.startsWith('memory.')) {
            add('Memory payload', data.memory ?? data);
        }
    }

    const stack = extractStack(ev);
    add('Stack / Source', stack, false, isFailureEvent(ev) ? 'error' : 'default');
    add('Raw JSON', ev, false);
    return sections;
}
