import type { TranscriptEvent } from '../types';
import { eventLane } from './turns';

export type InspectPresetId = 'human_loop' | 'memory' | 'movement' | 'debug_noise' | 'errors_only' | 'all';

export type Preset = {
    id: InspectPresetId;
    label: string;
    stages: string[] | null;
    /** Merged with server-side event_regex when set */
    eventRegex: string | null;
};

export const INSPECT_STAGE_ORDER = [
    'system',
    'connection',
    'inbound',
    'memory',
    'prompt',
    'model',
    'command',
    'action',
    'objective',
    'mode',
    'loop',
    'pathfinder',
    'outbound',
    'task',
    'legacy',
] as const;

export const PRESETS: Preset[] = [
    {
        id: 'human_loop',
        label: 'Story',
        /** Include legacy so JSONL rows without `stage` (pre-change transcripts) are not filtered out entirely. */
        stages: ['inbound', 'prompt', 'model', 'command', 'outbound', 'action', 'legacy'],
        eventRegex: null,
    },
    {
        id: 'memory',
        label: 'Memory',
        stages: ['memory'],
        eventRegex: null,
    },
    {
        id: 'movement',
        label: 'Movement',
        stages: ['pathfinder'],
        eventRegex: null,
    },
    {
        id: 'debug_noise',
        label: 'Debug-heavy',
        stages: null,
        eventRegex:
            'pathfinder\\.|mode\\.|self_prompter\\.|prompt\\.placeholders|connection\\.latency',
    },
    {
        id: 'errors_only',
        label: 'Errors only',
        stages: null,
        eventRegex: '\\.failure$|\\.error$|model\\.error|connection\\.kicked|action\\.stuck|pathfinder\\.(no_path|timeout)',
    },
    {
        id: 'all',
        label: 'Raw',
        stages: null,
        eventRegex: null,
    },
];

/** Collapse noisy events inside timeline when preset wants a cleaner story */
export function shouldCollapseByDefault(ev: TranscriptEvent, preset: InspectPresetId): boolean {
    if (preset !== 'human_loop') return false;
    const lane = eventLane(ev);
    const evn = ev.event ?? '';
    if (lane === 'pathfinder' && evn.includes('pathfinder.progress')) return true;
    if (lane === 'mode' || lane === 'loop') return true;
    if (evn === 'connection.latency') return true;
    return false;
}
