import type { CSSProperties } from 'react';

const BASE_VERSIONS = ['1.21.8'];
const PATH_CANDIDATES = ['items', 'blocks'] as const;

function proxiedUrl(agentName: string, itemName: string): string {
    return `/assets/item/${encodeURIComponent(agentName)}/${encodeURIComponent(itemName)}.png`;
}

function remoteUrl(version: string, pathType: string, itemName: string): string {
    return `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/${version}/${pathType}/${itemName}.png`;
}

const FALLBACK_SVG =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>',
    );

export function useItemIconCandidates(itemName: string, agentName: string, preferredVersion?: string): string[] {
    return useMemo(() => {
        const names = String(itemName).toLowerCase();
        const vers = preferredVersion && preferredVersion !== 'auto' ? [preferredVersion, ...BASE_VERSIONS] : [...BASE_VERSIONS];
        const seen = new Set<string>();
        const out: string[] = [];
        const push = (u: string) => {
            if (!seen.has(u)) {
                seen.add(u);
                out.push(u);
            }
        };
        push(proxiedUrl(agentName, names));
        for (const v of vers) {
            for (const p of PATH_CANDIDATES) push(remoteUrl(v, p, names));
        }
        return out;
    }, [itemName, agentName, preferredVersion]);
}

type Props = {
    itemName: string;
    agentName: string;
    title?: string;
    className?: string;
    style?: CSSProperties;
    preferredVersion?: string;
};

export function ItemIcon({ itemName, agentName, title, className, style, preferredVersion }: Props) {
    const urls = useItemIconCandidates(itemName, agentName, preferredVersion);
    const [idx, setIdx] = useState(0);
    useEffect(() => setIdx(0), [urls]);
    const onErr = useCallback(() => {
        setIdx((i) => Math.min(i + 1, urls.length));
    }, [urls.length]);

    const src = idx < urls.length ? urls[idx] : FALLBACK_SVG;
    return (
        <img
            className={className}
            style={style}
            src={src}
            alt={title ?? itemName}
            title={title}
            onError={idx < urls.length ? onErr : undefined}
        />
    );
}
