import type { TranscriptEvent } from '../types';

export type EnrichedEvent = TranscriptEvent & {
    turnIndex: number | null;
    turnLabel: string | null;
};

/**
 * Stack-based turn boundaries on message.handle.start / message.handle.end.
 */
export function enrichEventsWithTurns(events: TranscriptEvent[]): EnrichedEvent[] {
    const sorted = [...events].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    const stack: { index: number; trace?: string | null }[] = [];
    let counter = 0;

    return sorted.map((ev) => {
        const name = ev.event ?? '';

        let turnIndex: number | null = stack.length ? stack[stack.length - 1].index : null;
        let turnLabel: string | null =
            stack.length > 0
                ? stack[stack.length - 1].trace
                    ? `Turn ${stack[stack.length - 1].index} · ${String(stack[stack.length - 1].trace).slice(0, 8)}…`
                    : `Turn ${stack[stack.length - 1].index}`
                : null;

        if (name === 'message.handle.start') {
            counter += 1;
            const trace = typeof ev.trace_id === 'string' ? ev.trace_id : null;
            stack.push({ index: counter, trace });
            turnIndex = counter;
            turnLabel = trace ? `Turn ${counter} · ${trace.slice(0, 8)}…` : `Turn ${counter}`;
        } else if (name === 'message.handle.end') {
            const top = stack.length ? stack[stack.length - 1] : null;
            turnIndex = top?.index ?? null;
            turnLabel = top
                ? top.trace
                    ? `Turn ${top.index} · ${top.trace.slice(0, 8)}…`
                    : `Turn ${top.index}`
                : null;
            stack.pop();
        }

        return {
            ...ev,
            turnIndex,
            turnLabel,
        };
    });
}

export function eventLane(ev: TranscriptEvent): string {
    if (ev.stage === '' || ev.stage === undefined || ev.stage === null) return 'legacy';
    return ev.stage;
}

export function isFailureEvent(ev: TranscriptEvent): boolean {
    const n = ev.event;
    if (!n || typeof n !== 'string') return false;
    if (n.endsWith('.failure')) return true;
    if (
        n === 'model.error' ||
        n === 'connection.kicked' ||
        n === 'action.stuck' ||
        n === 'pathfinder.no_path' ||
        n === 'pathfinder.timeout'
    ) {
        return true;
    }
    return false;
}
