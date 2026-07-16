import { useEffect, useState } from 'react';
import { getSocket } from '../socket';

export function useMindserverConnection(): boolean {
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const s = getSocket();
        const onConnect = () => setConnected(true);
        const onDisconnect = () => setConnected(false);
        s.on('connect', onConnect);
        s.on('disconnect', onDisconnect);
        if (s.connected) setConnected(true);
        return () => {
            s.off('connect', onConnect);
            s.off('disconnect', onDisconnect);
        };
    }, []);

    return connected;
}
