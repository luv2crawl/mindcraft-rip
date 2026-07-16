import * as skills from '../library/skills.js';
import { formatObjectiveResult, objectiveResult } from './objective_results.js';
import settings from '../settings.js';

export function recordMiningCompletion(agent, oreName, result) {
    if (!agent?.memory_bank || !result?.ok || !Number.isFinite(Number(result.data?.verified ?? result.data?.mined))) return;
    const mined = Number(result.data.verified ?? result.data.mined);
    if (mined <= 0) return;

    const now = new Date().toISOString();
    const dropName = skills.getMiningDropNames(oreName)[0] || String(oreName || '').toLowerCase().replace(/\s+/g, '_');
    const existingStorage = agent.memory_bank.recall('storage', 'home_chest');
    const homePlace = agent.memory_bank.recall('places', 'home_chest');
    const base = existingStorage || (Array.isArray(homePlace)
        ? { name: 'home_chest', x: homePlace[0], y: homePlace[1], z: homePlace[2] }
        : homePlace) || { name: 'home_chest' };
    const counts = { ...(base.counts || {}) };
    counts[dropName] = (counts[dropName] || 0) + mined;

    agent.memory_bank.remember('storage', 'home_chest', {
        ...base,
        name: 'home_chest',
        counts,
        contentsIndexedAt: base.contentsIndexedAt || base.indexedAt || now,
        indexedAt: base.indexedAt || base.contentsIndexedAt || now,
        updatedAt: now,
        verifiedAt: base.verifiedAt || now,
        source: 'mining_objective',
    });
    agent.memory_bank.remember('observations', `mined_${dropName}_${Date.now()}`, {
        type: 'mining_completion',
        ore: oreName,
        drop: dropName,
        mined,
        target: result.data.target,
        depositedTo: 'home_chest',
        createdAt: now,
    });
}

export function planMiningRun(agent, oreName, num) {
    if (!agent?.bot) {
        return objectiveResult({
            ok: false,
            reason: 'no_bot',
            message: 'Cannot plan mining run before bot is initialized.',
        });
    }
    return skills.planMiningRun(agent.bot, oreName, num, { memoryBank: agent.memory_bank });
}

export function formatMiningPlan(plan) {
    return formatObjectiveResult(plan);
}

function countInventoryMiningDrops(bot, oreName) {
    const info = skills.getMiningDropNames(oreName);
    const names = new Set(info);
    const oreInfo = skills.getOreInfo?.(oreName);
    for (const blockName of oreInfo?.block_names || []) names.add(blockName);
    let count = 0;
    for (const item of bot?.inventory?.items?.() || []) {
        if (names.has(item.name)) count += item.count;
    }
    return count;
}

function countDepositedMiningDrops(oreName, depositedCounts = {}) {
    const names = new Set(skills.getMiningDropNames(oreName));
    const oreInfo = skills.getOreInfo?.(oreName);
    for (const blockName of oreInfo?.block_names || []) names.add(blockName);
    let count = 0;
    for (const [itemName, itemCount] of Object.entries(depositedCounts || {})) {
        if (names.has(itemName)) count += Number(itemCount) || 0;
    }
    return count;
}

function updateTask(agent, patch) {
    agent.task_ledger?.update?.(patch);
}

function chatTask(agent, message) {
    if (settings.task_status_chat_enabled !== false) agent.openChat?.(message);
}

export function buildVerifiedMiningResult(agent, oreName, result, fallbackTarget) {
    const rawSuccess = typeof result === 'object' ? result.ok : !!result;
    const mined = typeof result === 'object' ? result.mined : undefined;
    const target = typeof result === 'object' ? result.target : fallbackTarget;
    const reason = typeof result === 'object' ? result.reason : (result ? 'done' : 'failed');
    const details = typeof result === 'object' ? result.data : {};
    const inventoryVerified = countInventoryMiningDrops(agent.bot, oreName);
    const depositedVerified = countDepositedMiningDrops(oreName, details.depositedCounts);
    const verified = inventoryVerified + depositedVerified;
    const verifyCompletion = settings.mining_verify_completion !== false;
    const success = (verifyCompletion ? verified >= target : rawSuccess);
    const verifiedReason = rawSuccess && !success ? 'mining_verification_failed' : reason;
    return objectiveResult({
        ok: success,
        reason: success ? 'done' : verifiedReason,
        message: success
            ? `Mining objective completed for ${oreName}.`
            : rawSuccess
                ? `Mining objective could not be verified for ${oreName}: verified ${verified}/${target}.`
                : `Mining objective incomplete for ${oreName}: mined ${mined ?? 0}/${target}, verified ${verified}/${target}.`,
        recommendedCommands: success ? [] : (rawSuccess
            ? ['!recoverDroppedItems', '!taskStatus']
            : ['!taskStatus']),
        data: { mined, verified, inventoryVerified, depositedVerified, target, ...details },
    });
}

export async function runMiningObjective(agent, oreName, num) {
    agent.task_ledger?.start?.({
        userGoal: `mine ${num} ${oreName}`,
        kind: 'mine',
        target: oreName,
        targetCount: num,
        phase: 'PLAN',
        progress: { verified: 0, target: num },
        nextAction: `!mineOre("${oreName}", ${num})`,
    });
    chatTask(agent, `Started task: mine ${num} ${oreName}.`);
    const frame = agent.objectives.push({
        type: 'mine_ore',
        args: { ore_name: oreName, num },
        state: 'PLAN',
        status: 'running',
    });
    const update = (state, patch = {}) => {
        updateTask(agent, {
            phase: state,
            status: 'running',
            progress: {
                ...(agent.task_ledger?.current?.progress || {}),
                target: num,
            },
            ...patch.taskLedger,
        });
        return agent.objectives.updateTop({ state, status: 'running', ...patch });
    };
    const logResult = (result) => {
        if (agent?.bot) skills.log(agent.bot, formatMiningPlan(result));
    };
    let finalResult = null;
    try {
        const plan = planMiningRun(agent, oreName, num);
        update('PLAN', { result: plan });
        if (!plan.ok && plan.reason !== 'missing_supplies') {
            agent.objectives.updateTop({ state: 'FAILED', status: 'failed', result: plan });
            agent.task_ledger?.block?.(plan.reason, {
                phase: 'PLAN',
                progress: { verified: 0, target: num },
                nextAction: plan.recommendedCommands?.[0] || '!taskStatus',
                evidence: { plan },
            });
            chatTask(agent, `Blocked mining ${oreName}: ${plan.reason}.`);
            logResult(plan);
            finalResult = plan;
            return formatMiningPlan(plan);
        }

        update('PREPARE_SUPPLIES');
        const result = await skills.mineOreAt(agent.bot, oreName, num, {
            memoryBank: agent.memory_bank,
            objectiveFrame: frame,
            objectiveUpdate: update,
        });
        finalResult = buildVerifiedMiningResult(agent, oreName, result, num);
        const { mined, verified, target, inventoryVerified, depositedVerified, depositedCounts = {} } = finalResult.data;
        agent.objectives.updateTop({
            state: finalResult.ok ? 'DONE' : 'FAILED',
            status: finalResult.ok ? 'completed' : 'failed',
            result: finalResult,
        });
        if (finalResult.ok) {
            agent.task_ledger?.complete?.({
                phase: 'DONE',
                progress: { mined, verified, target },
                evidence: { inventoryVerified, depositedVerified, depositedCounts },
                nextAction: null,
            });
            chatTask(agent, `Completed task: mined ${verified}/${target} ${oreName} verified.`);
            recordMiningCompletion(agent, oreName, finalResult);
        } else {
            const blockPhase = finalResult.reason === 'mining_verification_failed'
                ? 'VERIFY'
                : (agent.task_ledger?.current?.phase || 'FAILED');
            agent.task_ledger?.block?.(finalResult.reason, {
                phase: blockPhase,
                progress: { mined, verified, target },
                evidence: { inventoryVerified, depositedVerified, depositedCounts },
                nextAction: finalResult.recommendedCommands?.[0] || '!taskStatus',
            });
            chatTask(agent, `Blocked mining ${oreName}: ${finalResult.reason} (${verified}/${target} verified).`);
        }
        logResult(finalResult);
        return formatMiningPlan(finalResult);
    } catch (error) {
        finalResult = objectiveResult({
            ok: false,
            reason: 'exception',
            message: `Mining objective threw: ${error?.message || String(error)}.`,
            data: {
                error: error?.message || String(error),
            },
        });
        agent.transcript?.record('objective.failure', {
            type: 'mine_ore',
            ore_name: oreName,
            num,
            error
        }, 'objectives', { stage: 'objective' });
        agent.objectives.updateTop({
            state: 'FAILED',
            status: 'failed',
            result: finalResult,
            error: finalResult.message
        });
        agent.task_ledger?.block?.('exception', {
            phase: 'FAILED',
            progress: { ...(agent.task_ledger?.current?.progress || {}), target: num },
            evidence: { error: error?.message || String(error) },
            nextAction: '!taskStatus',
        });
        chatTask(agent, `Blocked mining ${oreName}: exception.`);
        logResult(finalResult);
        return formatMiningPlan(finalResult);
    } finally {
        if (agent.objectives.peek()?.id === frame.id) {
            agent.objectives.pop(finalResult);
        }
    }
}
