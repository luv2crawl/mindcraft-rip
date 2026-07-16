import type { CSSProperties } from 'react';
import type { SettingsSpec } from '../types';

type Values = Record<string, unknown>;

type Props = {
    spec: SettingsSpec;
    values: Values;
    idPrefix: string;
    onChange: (next: Values) => void;
};

export function SettingsFormFields({ spec, values, idPrefix, onChange }: Props) {
    const keys = Object.keys(spec).filter((k) => k !== 'profile');

    function patch(key: string, val: unknown) {
        onChange({ ...values, [key]: val });
    }

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 8,
            }}
        >
            {keys.map((key) => {
                const cfg = spec[key];
                const id = `${idPrefix}-${key}`;
                return (
                    <label
                        key={key}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            background: 'var(--bg-muted)',
                            padding: '8px 10px',
                            borderRadius: 'var(--radius)',
                            border: '1px solid var(--border)',
                        }}
                        title={cfg.description}
                    >
                        <span
                            style={{
                                flex: '0 0 42%',
                                fontSize: '0.9em',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {key}
                        </span>
                        {cfg.type === 'boolean' ? (
                            <input
                                id={id}
                                type="checkbox"
                                checked={Boolean(values[key])}
                                onChange={(e) => patch(key, e.target.checked)}
                            />
                        ) : cfg.type === 'number' ? (
                            <input
                                id={id}
                                type="number"
                                style={inputStyle}
                                value={Number(values[key] ?? cfg.default ?? 0)}
                                onChange={(e) => patch(key, Number(e.target.value))}
                            />
                        ) : (
                            <input
                                id={id}
                                type="text"
                                style={inputStyle}
                                value={
                                    typeof values[key] === 'object'
                                        ? JSON.stringify(values[key])
                                        : String(values[key] ?? cfg.default ?? '')
                                }
                                onChange={(e) => {
                                    const raw = e.target.value;
                                    if (cfg.type === 'array' || cfg.type === 'object') {
                                        try {
                                            patch(key, JSON.parse(raw));
                                        } catch {
                                            patch(key, raw);
                                        }
                                    } else patch(key, raw);
                                }}
                            />
                        )}
                    </label>
                );
            })}
        </div>
    );
}

const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    borderRadius: 4,
    padding: '4px 8px',
};
