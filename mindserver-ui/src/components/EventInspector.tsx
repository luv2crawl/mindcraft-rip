import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { TranscriptEvent } from '../types';
import { workspaceFileUrl } from '../api';
import { eventLane, isFailureEvent } from '../transcript/turns';
import {
    extractInspectorFields,
    extractInspectorSections,
    summarizeEvent,
} from '../transcript/inspectHelpers';
import styles from './InspectView.module.css';

export function linkifyWorkspaceStacks(text: string): ReactNode[] {
    const re = /((?:mindserver-ui\/)?src\/[^\s:]+\.[jt]sx?):(\d+)/g;
    const parts: ReactNode[] = [];
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push(text.slice(last, m.index));
        const path = m[1].replace(/^mindserver-ui\//, '');
        parts.push(
            <a key={key++} href={workspaceFileUrl(path)} target="_blank" rel="noreferrer">
                {m[1]}:{m[2]}
            </a>,
        );
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : [text];
}

type Props = {
    ev: TranscriptEvent | null;
};

export function EventInspector({ ev }: Props) {
    const fields = useMemo(() => (ev ? extractInspectorFields(ev) : []), [ev]);
    const sections = useMemo(() => (ev ? extractInspectorSections(ev) : []), [ev]);
    const summary = useMemo(() => (ev ? summarizeEvent(ev) : ''), [ev]);

    if (!ev) {
        return (
            <aside className={styles.detailsEmpty}>
                <div className={styles.emptyTitle}>No event selected</div>
                <p>Choose a row in the trace reader to inspect its payload.</p>
            </aside>
        );
    }

    const fail = isFailureEvent(ev);
    const eventName = ev.event ?? '(event)';

    return (
        <aside className={styles.detailsPanel} aria-label="Event details">
            <header className={styles.detailsHeader}>
                <div className={styles.detailsKicker}>
                    <span className={styles.lanePill}>{eventLane(ev)}</span>
                    {ev.trace_id ? <span className={styles.tracePill}>trace {ev.trace_id.slice(0, 10)}</span> : null}
                    {ev.source ? <span className={styles.tracePill}>{ev.source}</span> : null}
                </div>
                <h2 className={fail ? styles.failureTitle : undefined}>{eventName}</h2>
                <p>{summary}</p>
                <div className={styles.detailsMeta}>
                    <span>{ev.ts ?? 'No timestamp'}</span>
                    <span>line {String(ev.line)}</span>
                </div>
            </header>

            <section className={styles.fieldGrid} aria-label="Key fields">
                {fields.map((field) => (
                    <div key={`${field.label}-${field.value}`} className={styles.fieldItem}>
                        <div>{field.label}</div>
                        <strong>{field.value}</strong>
                    </div>
                ))}
            </section>

            <div className={styles.sectionStack}>
                {sections.map((section) => (
                    <details
                        key={section.title}
                        className={section.tone === 'error' ? styles.detailSectionError : styles.detailSection}
                        open={section.defaultOpen}
                    >
                        <summary>
                            <span>{section.title}</span>
                            <button
                                type="button"
                                className={styles.copyButton}
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(section.content).catch(() => undefined);
                                }}
                            >
                                Copy
                            </button>
                        </summary>
                        <pre>{section.title === 'Stack / Source' ? linkifyWorkspaceStacks(section.content) : section.content}</pre>
                    </details>
                ))}
            </div>
        </aside>
    );
}
