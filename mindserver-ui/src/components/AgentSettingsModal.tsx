import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSettingsSpec } from '../api';
import { emitGetSettings, emitSetAgentSettings } from '../socket';
import type { SettingsSpec } from '../types';
import { SettingsFormFields } from './SettingsFormFields';

type Props = {
    agentName: string | null;
    onClose: () => void;
    onAfterApply: (name: string) => void;
};

function shallowEqualSettings(a: Record<string, unknown>, b: Record<string, unknown>, spec: SettingsSpec): boolean {
    const keys = Object.keys(spec).filter((k) => k !== 'profile');
    for (const k of keys) {
        const va = a[k];
        const vb = b[k];
        if (typeof va === 'object' || typeof vb === 'object') {
            if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
        } else if (va !== vb) return false;
    }
    return true;
}

export function AgentSettingsModal({ agentName, onClose, onAfterApply }: Props) {
    const [spec, setSpec] = useState<SettingsSpec | null>(null);
    const [original, setOriginal] = useState<Record<string, unknown> | null>(null);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const open = Boolean(agentName);

    useEffect(() => {
        if (!agentName) return;
        void fetchSettingsSpec().then((s) => setSpec(s as SettingsSpec));
    }, [agentName]);

    useEffect(() => {
        if (!agentName) return;
        emitGetSettings(agentName, (res) => {
            const s = (res.settings ?? {}) as Record<string, unknown>;
            setOriginal(JSON.parse(JSON.stringify(s)));
            const next = { ...s };
            setValues(next);
        });
    }, [agentName]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const dirty = useMemo(() => {
        if (!original || !spec) return false;
        const edited = getEdited(values, spec, original);
        return !shallowEqualSettings(edited, original, spec);
    }, [original, spec, values]);

    const apply = useCallback(() => {
        if (!agentName || !original || !spec) return;
        const edited = getEdited(values, spec, original);
        emitSetAgentSettings(agentName, edited);
        onAfterApply(agentName);
        onClose();
    }, [agentName, original, spec, values, onAfterApply, onClose]);

    const discard = useCallback(() => {
        if (original) setValues({ ...original });
    }, [original]);

    if (!open || !agentName) return null;

    return (
        <div
            role="presentation"
            style={backdrop}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div role="dialog" aria-modal aria-labelledby="agent-settings-title" style={modal}>
                <header style={hdr}>
                    <h2 id="agent-settings-title" style={{ margin: 0 }}>
                        {agentName} settings
                    </h2>
                    <button type="button" style={closeBtn} onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </header>
                <div style={{ padding: '12px 16px', maxHeight: '70vh', overflow: 'auto' }}>
                    {spec ? (
                        <SettingsFormFields spec={spec} values={values} idPrefix="agent" onChange={setValues} />
                    ) : (
                        <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
                    )}
                </div>
                <footer style={ftr}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
                        Apply restarts the agent with new settings.
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" style={secondaryBtn} onClick={discard}>
                            Discard changes
                        </button>
                        <button type="button" style={primaryBtn} onClick={apply} disabled={!dirty}>
                            Apply &amp; restart
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
}

function getEdited(values: Record<string, unknown>, spec: SettingsSpec, original: Record<string, unknown>) {
    const out: Record<string, unknown> = { profile: (original.profile as Record<string, unknown>) || {} };
    for (const k of Object.keys(spec)) {
        if (k === 'profile') continue;
        out[k] = values[k];
    }
    return out;
}

const backdrop: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
};

const modal: CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    minWidth: 'min(920px, 96vw)',
    maxWidth: '96vw',
    boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
};

const hdr: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
};

const ftr: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderTop: '1px solid var(--border)',
    flexWrap: 'wrap',
};

const closeBtn: CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: '1.5rem',
    lineHeight: 1,
    cursor: 'pointer',
};

const primaryBtn: CSSProperties = {
    padding: '8px 16px',
    borderRadius: 'var(--radius)',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
};

const secondaryBtn: CSSProperties = {
    padding: '8px 16px',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border)',
    background: 'var(--bg-muted)',
    color: 'var(--text)',
};
