import { useCallback, useEffect, useState } from 'react';
import { AppShell, type MainTab } from './components/AppShell';
import { AgentsView } from './components/AgentsView';
import { CreateAgentModal } from './components/CreateAgentModal';
import { InspectView } from './components/InspectView';
import { fetchBots } from './api';
import { useMindserverConnection } from './hooks/useMindserverConnection';
import { getSocket } from './socket';
import { readUrlParams, setUrlParams } from './utils/urlParams';

function readUrlTab(): MainTab {
    return readUrlParams().tab;
}

export default function App() {
    const [tab, setTab] = useState<MainTab>(readUrlTab);
    const [inspectAvailable, setInspectAvailable] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const connected = useMindserverConnection();

    useEffect(() => {
        const t = readUrlParams().tab;
        if (t === 'inspect' || t === 'agents') setTab(t);
    }, []);

    useEffect(() => {
        setUrlParams({ tab: tab === 'inspect' ? 'inspect' : 'agents' });
    }, [tab]);

    const probeInspect = useCallback(async () => {
        const r = await fetchBots();
        setInspectAvailable(!r.forbidden && r.ok);
    }, []);

    useEffect(() => {
        void probeInspect();
    }, [probeInspect]);

    const openInspect = useCallback((name: string) => {
        setTab('inspect');
        setUrlParams({ tab: 'inspect', bot: name });
    }, []);

    const onDisconnectAll = useCallback(() => {
        getSocket().emit('stop-all-agents');
    }, []);
    const onShutdown = useCallback(() => {
        if (
            window.confirm(
                'Perform a full shutdown? This will stop all agents and close the server.',
            )
        ) {
            getSocket().emit('shutdown');
        }
    }, []);

    return (
        <>
            <AppShell
                tab={tab}
                onTabChange={setTab}
                connected={connected}
                inspectAvailable={inspectAvailable}
                onNewAgent={() => setCreateOpen(true)}
                onDisconnectAll={onDisconnectAll}
                onShutdown={onShutdown}
            >
            {tab === 'agents' ? (
                <AgentsView onOpenInspect={openInspect} />
            ) : inspectAvailable ? (
                <InspectView />
            ) : (
                <div style={{ padding: 24, color: 'var(--text-muted)' }}>
                    Inspect API is disabled for this server configuration (e.g. public host mode). Agents controls
                    still work over the socket.
                </div>
            )}
        </AppShell>
            <CreateAgentModal open={createOpen} onClose={() => setCreateOpen(false)} />
        </>
    );
}
