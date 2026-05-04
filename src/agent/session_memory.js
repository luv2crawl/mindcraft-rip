export function createSessionMemory() {
    return {
        activeObjectiveSummary: null,
        lastCommand: null,
        currentCommandName: null,
        currentResourceTarget: null,
        lastCommandResultCode: null,
        lastCommandResultData: {},
        lastFailureReason: null,
        nextRecommendedRecoveryCommand: null,
        lastSurfacedMemoryLabels: [],
    };
}

export function ensureSessionMemory(agent) {
    if (!agent) return createSessionMemory();
    if (!agent.session_memory || typeof agent.session_memory !== 'object') {
        agent.session_memory = createSessionMemory();
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

function reasonFromCode(code) {
    return String(code || '')
        .replace(/^ERR_/, '')
        .toLowerCase() || null;
}

export function noteCommandStart(agent, commandName, metadata = {}) {
    const session = ensureSessionMemory(agent);
    session.currentCommandName = commandName || null;
    if (metadata.resourceTarget) {
        session.currentResourceTarget = metadata.resourceTarget;
    }
    session.activeObjectiveSummary = summarizeObjectiveForSession(agent.objectives?.peek?.());
    return session;
}

export function noteCommandResult(agent, commandName, result, metadata = {}) {
    const session = ensureSessionMemory(agent);
    session.lastCommand = commandName || result?.commandName || null;
    session.currentCommandName = null;
    if (metadata.resourceTarget) {
        session.currentResourceTarget = metadata.resourceTarget;
    }
    session.lastCommandResultCode = result?.code || null;
    session.lastCommandResultData = result?.data || {};
    session.activeObjectiveSummary = summarizeObjectiveForSession(agent.objectives?.peek?.());

    if (result?.ok === false || String(result?.code || '').startsWith('ERR_')) {
        session.lastFailureReason = reasonFromCode(result?.code);
        session.nextRecommendedRecoveryCommand = result?.next_hints?.[0] || null;
    } else if (result?.ok === true || result?.code === 'OK') {
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
    if (session.lastCommandResultCode) parts.push(`last_result=${session.lastCommandResultCode}`);
    if (session.lastFailureReason) parts.push(`last_failure=${session.lastFailureReason}`);
    if (session.nextRecommendedRecoveryCommand) parts.push(`next=${session.nextRecommendedRecoveryCommand}`);
    if (session.lastSurfacedMemoryLabels?.length) {
        parts.push(`surfaced=${session.lastSurfacedMemoryLabels.slice(0, 8).join(',')}`);
    }
    return parts.length ? `Current session: ${parts.join('; ')}` : '';
}
