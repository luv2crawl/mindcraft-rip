import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { AgentFullState, AgentStatus } from '../types';
import { getSocket } from '../socket';
import { ItemIcon } from './ItemIcon';

function prettyItem(name: string): string {
    return String(name || '').replace(/_/g, ' ');
}

type Props = {
    agent: AgentStatus;
    state: AgentFullState | undefined;
    settings: Record<string, unknown> | undefined;
    lastMessage: string;
    onOpenInspect: (name: string) => void;
    onOpenSettings: (name: string) => void;
};

export function AgentCard({ agent, state, settings, lastMessage, onOpenInspect, onOpenSettings }: Props) {
    const [invOpen, setInvOpen] = useState(false);
    const [msg, setMsg] = useState('');
    const gp = state?.gameplay;
    const inv = state?.inventory;
    const mcVersion =
        typeof settings?.minecraft_version === 'string' && settings.minecraft_version !== 'auto'
            ? settings.minecraft_version
            : undefined;
    const showViewer = agent.in_game && settings?.render_bot_view === true;
    const viewerPort = agent.viewerPort;

    const send = (text: string) => {
        if (!text.trim()) return;
        getSocket().emit('send-message', agent.name, { from: 'ADMIN', message: text });
        setMsg('');
    };

    const armor = inv?.equipment;
    const counts = inv?.counts;

    const inGame = agent.in_game;
    const socketLabel = agent.socket_connected && !agent.in_game ? 'joining…' : '';

    const healthMax = typeof gp?.healthMax === 'number' ? gp.healthMax : 20;
    const hungerMax = typeof gp?.hungerMax === 'number' ? gp.hungerMax : 20;

    return (
        <div
            style={{
                background: 'var(--bg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: 12,
                marginBottom: 12,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: inGame ? 'var(--success)' : 'var(--danger)' }}>●</span>
                    <strong>{agent.name}</strong>
                    {socketLabel ? <span style={{ color: 'var(--warn)' }}>{socketLabel}</span> : null}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" style={gear} onClick={() => onOpenSettings(agent.name)} title="Settings">
                        Settings
                    </button>
                    <button type="button" style={gear} onClick={() => setInvOpen((v) => !v)}>
                        Inventory
                    </button>
                    <button type="button" style={gear} onClick={() => onOpenInspect(agent.name)}>
                        Inspect
                    </button>
                </div>
            </div>

            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    gap: 8,
                    marginTop: 10,
                }}
            >
                {showViewer ? (
                    <div style={{ gridColumn: 'span 2', minHeight: 200 }}>
                        <iframe
                            title={`viewer-${agent.name}`}
                            src={`http://localhost:${viewerPort}`}
                            style={{ width: '100%', height: 280, border: '1px solid var(--border)', borderRadius: 4 }}
                        />
                    </div>
                ) : null}
                <div style={cell}>action: {state?.action?.current ?? '—'}</div>
                <div style={cell}>gamemode: {gp?.gamemode ?? '—'}</div>
                <div style={cell}>
                    health: {typeof gp?.health === 'number' ? `${gp.health}/${healthMax}` : '—'}
                </div>
                <div style={cell}>
                    hunger: {typeof gp?.hunger === 'number' ? `${gp.hunger}/${hungerMax}` : '—'}
                </div>
                <div style={cell}>
                    pos:{' '}
                    {gp?.position
                        ? `x ${gp.position.x.toFixed(1)}, y ${gp.position.y.toFixed(1)}, z ${gp.position.z.toFixed(1)}`
                        : '—'}
                </div>
                <div style={cell}>biome: {gp?.biome ?? '—'}</div>
                <div style={cell}>
                    inventory slots:{' '}
                    {typeof inv?.stacksUsed === 'number' && typeof inv?.totalSlots === 'number'
                        ? `${inv.stacksUsed}/${inv.totalSlots}`
                        : '—'}
                </div>
                <div style={cell}>equipped: {armor?.mainHand ? prettyItem(armor.mainHand) : 'none'}</div>
            </div>

            {invOpen ? (
                <div style={{ marginTop: 12, padding: 10, background: 'var(--bg)', borderRadius: 6 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>Inventory</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        {(['helmet', 'chestplate', 'leggings', 'boots', 'mainHand'] as const).map((slot) => {
                            const it = armor?.[slot];
                            return it ? (
                                <div key={slot} style={slotWrap}>
                                    <ItemIcon itemName={it} agentName={agent.name} preferredVersion={mcVersion} style={icon} />
                                    <span style={{ fontSize: 11 }}>{slot}</span>
                                </div>
                            ) : (
                                <div key={slot} style={{ ...slotWrap, opacity: 0.5 }}>
                                    <span>—</span>
                                    <span style={{ fontSize: 11 }}>{slot}</span>
                                </div>
                            );
                        })}
                    </div>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                            gap: 8,
                        }}
                    >
                        {counts && Object.keys(counts).length ? (
                            Object.entries(counts)
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([k, v]) => (
                                    <div key={k} style={invItem}>
                                        <ItemIcon itemName={k} agentName={agent.name} preferredVersion={mcVersion} style={icon} />
                                        <span style={{ fontSize: 12 }}>{prettyItem(k)}</span>
                                        <span
                                            style={{
                                                position: 'absolute',
                                                right: 6,
                                                bottom: 6,
                                                background: '#000a',
                                                padding: '2px 6px',
                                                borderRadius: 4,
                                            }}
                                        >
                                            {v}
                                        </span>
                                    </div>
                                ))
                        ) : (
                            <div style={{ color: 'var(--text-muted)' }}>(empty)</div>
                        )}
                    </div>
                </div>
            ) : null}

            <div style={{ marginTop: 10, fontStyle: 'italic', color: 'var(--text-muted)', fontSize: '0.9em' }}>
                <strong>Last output:</strong> {lastMessage || '—'}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button type="button" style={btnPrimary} disabled={!msg.trim() || !inGame} onClick={() => send(msg)}>
                    Send
                </button>
                <input
                    style={input}
                    placeholder="Message…"
                    value={msg}
                    disabled={!inGame}
                    onChange={(e) => setMsg(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send(msg)}
                />
                <button type="button" style={btnNeutral} disabled={!inGame} onClick={() => send('!stop')}>
                    Stop action
                </button>
                <button type="button" style={btnNeutral} disabled={!inGame} onClick={() => send('!stay(-1)')}>
                    Stay still
                </button>
                <button
                    type="button"
                    style={btnNeutral}
                    disabled={!inGame}
                    onClick={() => getSocket().emit('restart-agent', agent.name)}
                >
                    Restart
                </button>
                <button
                    type="button"
                    style={btnNeutral}
                    disabled={!inGame && agent.socket_connected}
                    onClick={() =>
                        inGame
                            ? getSocket().emit('stop-agent', agent.name)
                            : getSocket().emit('start-agent', agent.name)
                    }
                >
                    {inGame ? 'Disconnect' : agent.socket_connected ? 'Connecting…' : 'Connect'}
                </button>
                <button type="button" style={btnDanger} onClick={() => getSocket().emit('destroy-agent', agent.name)}>
                    Remove
                </button>
            </div>
        </div>
    );
}

const cell: CSSProperties = {
    background: 'var(--bg-elevated)',
    padding: '6px 8px',
    borderRadius: 4,
    fontSize: '0.9em',
};

const gear: CSSProperties = {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
    fontSize: '0.85em',
};

const btnPrimary: CSSProperties = {
    padding: '6px 12px',
    borderRadius: 4,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
};

const btnNeutral: CSSProperties = {
    padding: '6px 12px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
};

const btnDanger: CSSProperties = {
    padding: '6px 12px',
    borderRadius: 4,
    border: '1px solid #7a3535',
    background: 'rgba(232, 84, 84, 0.15)',
    color: '#ffb4b4',
};

const input: CSSProperties = {
    flex: '1 1 180px',
    minWidth: 120,
    padding: '6px 8px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
};

const icon: CSSProperties = {
    width: 28,
    height: 28,
    imageRendering: 'pixelated',
};

const slotWrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
};

const invItem: CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: 8,
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--bg-elevated)',
};
