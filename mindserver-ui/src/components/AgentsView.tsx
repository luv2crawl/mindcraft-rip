import { useCallback, useEffect, useState } from 'react';
import type { AgentStateMap, AgentStatus } from '../types';
import { emitGetSettings, getSocket, subscribeAgents } from '../socket';
import { AgentCard } from './AgentCard';
import { AgentSettingsModal } from './AgentSettingsModal';

type Props = {
    onOpenInspect: (botName: string) => void;
};

export function AgentsView({ onOpenInspect }: Props) {
    const [agents, setAgents] = useState<AgentStatus[]>([]);
    const [states, setStates] = useState<AgentStateMap>({});
    const [settingsMap, setSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
    const [lastByAgent, setLastByAgent] = useState<Record<string, string>>({});
    const [settingsAgent, setSettingsAgent] = useState<string | null>(null);

    const ensureSettings = useCallback((name: string) => {
        setSettingsMap((prev) => {
            if (prev[name]) return prev;
            emitGetSettings(name, (res) => {
                if (res.settings) {
                    setSettingsMap((p) => ({ ...p, [name]: res.settings as Record<string, unknown> }));
                }
            });
            return prev;
        });
    }, []);

    useEffect(() => {
        const s = getSocket();
        const onAgents = (list: AgentStatus[]) => {
            setAgents(list);
            list.forEach((a) => ensureSettings(a.name));
        };
        const onState = (st: AgentStateMap) => setStates(st);
        const onBotOut = (agentName: string, message: string) => {
            setLastByAgent((p) => ({ ...p, [agentName]: message }));
        };
        const onConnect = () => subscribeAgents();
        s.on('agents-status', onAgents);
        s.on('state-update', onState);
        s.on('bot-output', onBotOut);
        s.on('connect', onConnect);
        subscribeAgents();
        return () => {
            s.off('agents-status', onAgents);
            s.off('state-update', onState);
            s.off('bot-output', onBotOut);
            s.off('connect', onConnect);
        };
    }, [ensureSettings]);

    const onAfterApplySettings = useCallback((name: string) => {
        emitGetSettings(name, (res) => {
            if (res.settings) {
                setSettingsMap((p) => ({ ...p, [name]: res.settings as Record<string, unknown> }));
            }
        });
    }, []);

    if (!agents.length) {
        return <div style={{ color: 'var(--text-muted)' }}>No agents connected.</div>;
    }

    return (
        <div>
            {agents.map((a) => (
                <AgentCard
                    key={a.name}
                    agent={a}
                    state={states[a.name]}
                    settings={settingsMap[a.name]}
                    lastMessage={lastByAgent[a.name] ?? ''}
                    onOpenInspect={onOpenInspect}
                    onOpenSettings={setSettingsAgent}
                />
            ))}
            <AgentSettingsModal
                agentName={settingsAgent}
                onClose={() => setSettingsAgent(null)}
                onAfterApply={onAfterApplySettings}
            />
        </div>
    );
}
