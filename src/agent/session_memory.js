import { getKnownOres, getOreInfo } from './library/ore_data.js';

export function createSessionMemory() {
    return {
        activeObjectiveSummary: null,
        lastCommand: null,
        currentCommandName: null,
        currentResourceTarget: null,
        pendingTasks: [],
        lastCommandResultCode: null,
        lastCommandResultData: {},
        lastFailureReason: null,
        nextRecommendedRecoveryCommand: null,
        lastSurfacedMemoryLabels: [],
    };
}

function normalizeResourceName(name) {
    const normalized = String(name || '').toLowerCase().trim().replace(/\s+/g, '_');
    return getOreInfo(normalized)?.key || normalized || null;
}

function _wordPattern(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _-]');
}

export function extractRequestedResourceTargets(text = '') {
    const lower = String(text || '').toLowerCase();
    if (!/\b(?:mine|mining|collect|gather|get)\b/.test(lower)) return [];

    const matches = [];
    const knownOres = getKnownOres()
        .map(key => {
            const info = getOreInfo(key);
            return {
                key,
                aliases: [
                    key,
                    key.replace(/_/g, ' '),
                    `${key.replace(/_/g, ' ')} ore`,
                    ...(info?.block_names || []),
                ],
            };
        })
        .sort((a, b) => Math.max(...b.aliases.map(alias => alias.length)) - Math.max(...a.aliases.map(alias => alias.length)));

    for (const ore of knownOres) {
        if (matches.includes(ore.key)) continue;
        for (const alias of ore.aliases) {
            const pattern = new RegExp(`\\b${_wordPattern(alias)}s?\\b`, 'i');
            if (pattern.test(lower)) {
                matches.push(ore.key);
                break;
            }
        }
    }
    return matches;
}

function upsertPendingMineTargets(session, targets) {
    if (!Array.isArray(session.pendingTasks)) session.pendingTasks = [];
    for (const target of targets) {
        const item = normalizeResourceName(target);
        if (!item) continue;
        const existing = session.pendingTasks.find(task => task.kind === 'mine' && task.item === item);
        if (existing) {
            if (existing.status === 'done') existing.status = 'pending';
            continue;
        }
        session.pendingTasks.push({ kind: 'mine', item, status: 'pending' });
    }
    session.pendingTasks = session.pendingTasks.slice(-8);
}

function updatePendingTaskStatus(session, commandName, resourceTarget, status) {
    if (!Array.isArray(session.pendingTasks) || commandName !== '!mineOre') return;
    const item = normalizeResourceName(resourceTarget);
    if (!item) return;
    const existing = session.pendingTasks.find(task => task.kind === 'mine' && task.item === item);
    if (existing) existing.status = status;
}

export function ensureSessionMemory(agent) {
    if (!agent) return createSessionMemory();
    if (!agent.session_memory || typeof agent.session_memory !== 'object') {
        agent.session_memory = createSessionMemory();
    }
    if (!Array.isArray(agent.session_memory.pendingTasks)) {
        agent.session_memory.pendingTasks = [];
    }
    return agent.session_memory;
}

export function summarizeObjectiveForSession(frame) {
    if (!frame) return null;
    const args = Object.entries(frame.args || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
    return `#${frame.id ?? '?'} ${frame.type || 'objective'}(${args}) ${frame.status || 'pending'}/${frame.state || 'START'}`;
}

export function noteUserIntent(agent, message) {
    const session = ensureSessionMemory(agent);
    const targets = extractRequestedResourceTargets(message);
    if (targets.length > 0) {
        upsertPendingMineTargets(session, targets);
    }
    return session;
}

function reasonFromCode(code) {
    return String(code || '')
        .replace(/^ERR_/, '')
        .toLowerCase() || null;
}

export function noteCommandStart(agent, commandName, metadata = {}) {
    const session = ensureSessionMemory(agent);
    session.currentCommandName = commandName || null;
    if (metadata.resourceTarget) {
        session.currentResourceTarget = normalizeResourceName(metadata.resourceTarget);
        updatePendingTaskStatus(session, commandName, metadata.resourceTarget, 'active');
    }
    session.activeObjectiveSummary = summarizeObjectiveForSession(agent.objectives?.peek?.());
    return session;
}

export function noteCommandResult(agent, commandName, result, metadata = {}) {
    const session = ensureSessionMemory(agent);
    session.lastCommand = commandName || result?.commandName || null;
    session.currentCommandName = null;
    if (metadata.resourceTarget) {
        session.currentResourceTarget = normalizeResourceName(metadata.resourceTarget);
    }
    session.lastCommandResultCode = result?.code || null;
    session.lastCommandResultData = result?.data || {};
    session.activeObjectiveSummary = summarizeObjectiveForSession(agent.objectives?.peek?.());

    if (result?.ok === false || String(result?.code || '').startsWith('ERR_')) {
        updatePendingTaskStatus(session, commandName, metadata.resourceTarget, 'pending');
        session.lastFailureReason = reasonFromCode(result?.code);
        session.nextRecommendedRecoveryCommand = result?.next_hints?.[0] || null;
    } else if (result?.ok === true || result?.code === 'OK') {
        updatePendingTaskStatus(session, commandName, metadata.resourceTarget, 'done');
        session.lastFailureReason = null;
        session.nextRecommendedRecoveryCommand = null;
    }
    return session;
}

export function noteObjectiveUpdate(agent, frame) {
    const session = ensureSessionMemory(agent);
    session.activeObjectiveSummary = summarizeObjectiveForSession(frame || agent.objectives?.peek?.());
    if (frame?.result?.ok === false) {
        session.lastFailureReason = frame.result.reason || session.lastFailureReason;
        session.nextRecommendedRecoveryCommand = frame.result.recommendedCommands?.[0] || session.nextRecommendedRecoveryCommand;
    }
    return session;
}

export function formatSessionMemory(session) {
    if (!session || typeof session !== 'object') return '';
    const parts = [];
    if (session.activeObjectiveSummary) parts.push(`objective=${session.activeObjectiveSummary}`);
    if (session.lastCommand) parts.push(`last_command=${session.lastCommand}`);
    if (session.currentCommandName) parts.push(`current_command=${session.currentCommandName}`);
    if (session.currentResourceTarget) parts.push(`target=${session.currentResourceTarget}`);
    const pendingTasks = (session.pendingTasks || []).filter(task => task?.status !== 'done');
    if (pendingTasks.length) {
        parts.push(`pending=${pendingTasks.map(task => `${task.kind}:${task.item}`).join(',')}`);
    }
    if (session.lastCommandResultCode) parts.push(`last_result=${session.lastCommandResultCode}`);
    if (session.lastFailureReason) parts.push(`last_failure=${session.lastFailureReason}`);
    if (session.nextRecommendedRecoveryCommand) parts.push(`next=${session.nextRecommendedRecoveryCommand}`);
    if (session.lastSurfacedMemoryLabels?.length) {
        parts.push(`surfaced=${session.lastSurfacedMemoryLabels.slice(0, 8).join(',')}`);
    }
    return parts.length ? `Current session: ${parts.join('; ')}` : '';
}
