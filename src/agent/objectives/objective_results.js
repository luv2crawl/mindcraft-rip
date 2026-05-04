export function objectiveResult({
    ok = false,
    reason = ok ? 'ok' : 'failed',
    message = '',
    need = {},
    have = {},
    missing = {},
    recommendedCommands = [],
    data = {},
} = {}) {
    return {
        ok,
        reason,
        message,
        need,
        have,
        missing,
        recommendedCommands,
        data,
    };
}

function formatCounts(counts) {
    const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
    if (entries.length === 0) return 'none';
    return entries.map(([item, count]) => `${item} x${count}`).join(', ');
}

export function formatObjectiveResult(result) {
    if (!result) return '';
    const lines = [];
    lines.push(`${result.ok ? 'OK' : 'FAILED'}: ${result.reason}`);
    if (result.message) lines.push(result.message);
    if (result.need && Object.keys(result.need).length > 0) {
        lines.push(`Need: ${formatCounts(result.need)}`);
    }
    if (result.have && Object.keys(result.have).length > 0) {
        lines.push(`Have: ${formatCounts(result.have)}`);
    }
    if (result.missing && Object.keys(result.missing).length > 0) {
        lines.push(`Missing: ${formatCounts(result.missing)}`);
    }
    if (result.recommendedCommands && result.recommendedCommands.length > 0) {
        lines.push(`Recommended: ${result.recommendedCommands.join(' then ')}`);
    }
    if (result.data && Object.keys(result.data).length > 0) {
        const entries = Object.entries(result.data)
            .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
            .map(([key, value]) => `${key}: ${value}`);
        if (entries.length > 0) lines.push(`Data: ${entries.join(', ')}`);
    }
    return lines.join('\n');
}
