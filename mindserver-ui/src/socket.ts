import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
    if (!socket) {
        const base = window.location.pathname.replace(/\/+$/, '');
        const socketPath = `${base}/socket.io`.replace(/^\/{2,}/, '/');
        socket = io({ path: socketPath });
    }
    return socket;
}

export type CreateAgentResult = { success: boolean; error?: string };

export function emitCreateAgent(settings: Record<string, unknown>, cb: (res: CreateAgentResult) => void): void {
    getSocket().emit('create-agent', settings, cb);
}

export function emitGetSettings(agentName: string, cb: (res: { settings?: Record<string, unknown> }) => void): void {
    getSocket().emit('get-settings', agentName, cb);
}

export function emitSetAgentSettings(agentName: string, settings: Record<string, unknown>): void {
    getSocket().emit('set-agent-settings', agentName, settings);
}

export function subscribeAgents(): void {
    getSocket().emit('listen-to-agents');
}
