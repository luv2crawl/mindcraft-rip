import { type ReactNode } from 'react';
import styles from './AppShell.module.css';

export type MainTab = 'agents' | 'inspect';

type Props = {
    tab: MainTab;
    onTabChange: (t: MainTab) => void;
    connected: boolean;
    inspectAvailable: boolean;
    onNewAgent: () => void;
    onDisconnectAll: () => void;
    onShutdown: () => void;
    children: ReactNode;
};

export function AppShell({
    tab,
    onTabChange,
    connected,
    inspectAvailable,
    onNewAgent,
    onDisconnectAll,
    onShutdown,
    children,
}: Props) {
    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleRow}>
                    <h1 className={styles.title}>Mindcraft</h1>
                    <span className={`${styles.status} ${connected ? styles.statusOn : styles.statusOff}`}>
                        {connected ? 'MindServer online' : 'MindServer offline'}
                    </span>
                </div>
                <nav className={styles.tabs} aria-label="Main views">
                    <button
                        type="button"
                        className={tab === 'agents' ? styles.tabActive : styles.tab}
                        onClick={() => onTabChange('agents')}
                    >
                        Agents
                    </button>
                    <button
                        type="button"
                        className={tab === 'inspect' ? styles.tabActive : styles.tab}
                        onClick={() => inspectAvailable && onTabChange('inspect')}
                        disabled={!inspectAvailable}
                        title={!inspectAvailable ? 'Inspect API unavailable' : undefined}
                    >
                        Inspect
                    </button>
                </nav>
            </header>

            <main className={`${styles.main} ${tab === 'inspect' ? styles.mainInspect : ''}`}>{children}</main>

            <footer className={styles.footer}>
                <button type="button" className={styles.btnPrimary} onClick={onNewAgent}>
                    New Agent
                </button>
                <div className={styles.footerRight}>
                    <button type="button" className={styles.btnDanger} onClick={onDisconnectAll}>
                        Disconnect All Agents
                    </button>
                    <button type="button" className={styles.btnDanger} onClick={onShutdown}>
                        Full Shutdown
                    </button>
                </div>
            </footer>
        </div>
    );
}
