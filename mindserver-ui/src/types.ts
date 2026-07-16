export type AgentStatus = {
    name: string;
    in_game: boolean;
    viewerPort: number;
    socket_connected: boolean;
};

export type SettingsSpecEntry = {
    type: 'boolean' | 'number' | 'string' | 'array' | 'object';
    default: unknown;
    description?: string;
};

export type SettingsSpec = Record<string, SettingsSpecEntry>;

export type TranscriptEvent = {
    line: number | string;
    ts?: string;
    event?: string;
    stage?: string | null;
    source?: string | null;
    data?: unknown;
    session_id?: string;
    agent?: string;
    trace_id?: string | null;
    _live?: boolean;
};

export type SessionSummary = {
    id: string;
    path: string;
    size: number;
    mtime: string;
    error_count: number;
    first_ts: string | null;
    last_ts: string | null;
    duration_ms: number | null;
    debug_available: boolean;
};

export type GameplayState = {
    health?: number;
    healthMax?: number;
    hunger?: number;
    hungerMax?: number;
    position?: { x: number; y: number; z: number };
    biome?: string;
    gamemode?: string;
};

export type Equipment = {
    helmet?: string;
    chestplate?: string;
    leggings?: string;
    boots?: string;
    mainHand?: string;
};

export type AgentFullState = {
    error?: string;
    gameplay?: GameplayState;
    action?: { current?: string };
    inventory?: {
        stacksUsed?: number;
        totalSlots?: number;
        counts?: Record<string, number>;
        equipment?: Equipment;
    };
};

export type AgentStateMap = Record<string, AgentFullState>;
