import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { fetchSettingsSpec } from '../api';
import { emitCreateAgent } from '../socket';
import type { SettingsSpec } from '../types';
import { SettingsFormFields } from './SettingsFormFields';

type Props = {
    open: boolean;
    onClose: () => void;
};

function defaultsFromSpec(spec: SettingsSpec | null): Record<string, unknown> {
    if (!spec) return {};
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
        if (k === 'profile') continue;
        o[k] = v.default;
    }
    return o;
}

export function CreateAgentModal({ open, onClose }: Props) {
    const [spec, setSpec] = useState<SettingsSpec | null>(null);
    const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [error, setError] = useState('');
    const [profileLabel, setProfileLabel] = useState('Profile: Not uploaded');

    useEffect(() => {
        if (!open) return;
        void fetchSettingsSpec().then((s) => {
            const typed = s as SettingsSpec;
            setSpec(typed);
            setValues(defaultsFromSpec(typed));
        });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const canSubmit = Boolean(profile);

    const onPickProfile = useCallback((file: File | null) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const j = JSON.parse(String(reader.result)) as Record<string, unknown>;
                setProfile(j);
                setProfileLabel(`Profile: ${String(j.name || 'Uploaded')}`);
                setError('');
            } catch (e) {
                setProfile(null);
                setProfileLabel('Profile: Not uploaded');
                setError('Invalid profile JSON: ' + (e instanceof Error ? e.message : String(e)));
            }
        };
        reader.readAsText(file);
    }, []);

    const submit = useCallback(() => {
        if (!profile || !spec) return;
        const settings: Record<string, unknown> = { profile };
        for (const k of Object.keys(spec)) {
            if (k === 'profile') continue;
            settings[k] = values[k];
        }
        emitCreateAgent(settings, (res) => {
            if (!res.success) {
                setError(res.error || 'Unknown error');
                return;
            }
            setProfile(null);
            setProfileLabel('Profile: Not uploaded');
            setError('');
            onClose();
        });
    }, [profile, spec, values, onClose]);

    if (!open) return null;

    return (
        <div
            role="presentation"
            style={backdrop}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div role="dialog" aria-modal aria-labelledby="create-agent-title" style={modal}>
                <header style={hdr}>
                    <h2 id="create-agent-title" style={{ margin: 0 }}>
                        Create Agent
                    </h2>
                    <button type="button" style={closeBtn} onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </header>
                <div style={{ padding: '12px 16px', maxHeight: '70vh', overflow: 'auto' }}>
                    <div style={{ marginBottom: 8 }}>{profileLabel}</div>
                    {spec ? (
                        <SettingsFormFields spec={spec} values={values} idPrefix="create" onChange={setValues} />
                    ) : (
                        <div style={{ color: 'var(--text-muted)' }}>Loading settings…</div>
                    )}
                    {error ? <div style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</div> : null}
                    <input
                        type="file"
                        accept=".json,application/json"
                        style={{ marginTop: 12 }}
                        onChange={(e) => onPickProfile(e.target.files?.[0] ?? null)}
                    />
                </div>
                <footer style={ftr}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
                        Upload a profile JSON, adjust settings, then create.
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" style={secondaryBtn} onClick={onClose}>
                            Cancel
                        </button>
                        <button type="button" style={primaryBtn} disabled={!canSubmit} onClick={submit}>
                            Create Agent
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
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
