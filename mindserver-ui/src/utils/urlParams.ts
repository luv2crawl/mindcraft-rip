export function setUrlParams(updates: Record<string, string | null | undefined>) {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === undefined || v === '') u.searchParams.delete(k);
        else u.searchParams.set(k, v);
    }
    window.history.replaceState({}, '', u);
}

export function readUrlParams(): {
    tab: 'agents' | 'inspect';
    bot: string | null;
    session: string | null;
} {
    const p = new URLSearchParams(window.location.search);
    const tab = p.get('tab') === 'inspect' ? 'inspect' : 'agents';
    return { tab, bot: p.get('bot'), session: p.get('session') };
}
