import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TranscriptEvent } from '../types';
import type { EnrichedEvent } from '../transcript/turns';
import { eventLane, isFailureEvent } from '../transcript/turns';
import type { InspectPresetId } from '../transcript/presets';
import { shouldCollapseByDefault } from '../transcript/presets';
import { eventKey, summarizeEvent } from '../transcript/inspectHelpers';
import styles from './InspectView.module.css';

type Row =
    | { kind: 'turn'; label: string; key: string }
    | { kind: 'event'; ev: EnrichedEvent }
    | { kind: 'group'; label: string; count: number; key: string };

type Props = {
    events: EnrichedEvent[];
    selected: TranscriptEvent | null;
    onSelect: (ev: TranscriptEvent) => void;
    preset: InspectPresetId;
    collapseNoisy: boolean;
    emptyHint?: string;
};

function groupLabel(ev: EnrichedEvent): string {
    return ev.turnLabel || 'Startup / no turn';
}

function buildRows(events: EnrichedEvent[], preset: InspectPresetId, collapseNoisy: boolean): Row[] {
    const rows: Row[] = [];
    const hidden = new Set<number>();
    if (collapseNoisy) {
        events.forEach((ev, i) => {
            if (shouldCollapseByDefault(ev, preset)) hidden.add(i);
        });
    }

    let currentGroup = '';
    let i = 0;
    while (i < events.length) {
        const label = groupLabel(events[i]);
        if (label !== currentGroup) {
            currentGroup = label;
            rows.push({ kind: 'turn', label, key: `turn-${label}-${i}` });
        }

        if (hidden.has(i)) {
            const start = i;
            while (i < events.length && hidden.has(i) && groupLabel(events[i]) === label) i++;
            rows.push({
                kind: 'group',
                label: `Collapsed ${i - start} noisy ${i - start === 1 ? 'event' : 'events'}`,
                count: i - start,
                key: `collapsed-${start}-${i}`,
            });
            continue;
        }

        rows.push({ kind: 'event', ev: events[i] });
        i++;
    }
    return rows;
}

function rowSize(row: Row): number {
    if (row.kind === 'turn') return 34;
    if (row.kind === 'group') return 42;
    return 72;
}

export function EventTimeline({ events, selected, onSelect, preset, collapseNoisy, emptyHint }: Props) {
    const parentRef = useRef<HTMLDivElement>(null);
    const rows = useMemo(() => buildRows(events, preset, collapseNoisy), [events, preset, collapseNoisy]);
    const selectedKey = eventKey(selected);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: (index) => rowSize(rows[index]),
        overscan: 12,
    });

    if (!events.length) {
        return (
            <div className={styles.timelineEmpty}>
                <div className={styles.emptyTitle}>No events in this slice</div>
                {emptyHint ? <p>{emptyHint}</p> : <p>Widen the filters or choose another session.</p>}
            </div>
        );
    }

    return (
        <div ref={parentRef} className={styles.timelineScroller}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                    const row = rows[vi.index];
                    const top = vi.start;

                    if (row.kind === 'turn') {
                        return (
                            <div
                                key={row.key}
                                className={styles.turnHeader}
                                style={{ transform: `translateY(${top}px)`, height: vi.size }}
                            >
                                {row.label}
                            </div>
                        );
                    }

                    if (row.kind === 'group') {
                        return (
                            <div
                                key={row.key}
                                className={styles.collapsedRow}
                                style={{ transform: `translateY(${top}px)`, height: vi.size }}
                            >
                                <span>{row.label}</span>
                                <span>{row.count} hidden</span>
                            </div>
                        );
                    }

                    const ev = row.ev;
                    const fail = isFailureEvent(ev);
                    const selectedRow = selectedKey === eventKey(ev);
                    return (
                        <button
                            key={`${eventKey(ev)}-${vi.index}`}
                            type="button"
                            onClick={() => onSelect(ev)}
                            className={[
                                styles.timelineRow,
                                selectedRow ? styles.timelineRowSelected : '',
                                fail ? styles.timelineRowFailure : '',
                            ]
                                .filter(Boolean)
                                .join(' ')}
                            style={{ transform: `translateY(${top}px)`, height: vi.size }}
                        >
                            <span className={styles.lanePill}>{eventLane(ev)}</span>
                            <span className={styles.eventBody}>
                                <strong>{ev.event ?? '(event)'}</strong>
                                <span>{summarizeEvent(ev)}</span>
                            </span>
                            <span className={styles.eventTime}>{ev.ts ?? `line ${String(ev.line)}`}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
