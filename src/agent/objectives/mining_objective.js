import * as skills from '../library/skills.js';
import { formatObjectiveResult, objectiveResult } from './objective_results.js';

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

export async function runMiningObjective(agent, oreName, num) {
    const frame = agent.objectives.push({
        type: 'mine_ore',
        args: { ore_name: oreName, num },
        state: 'PLAN',
        status: 'running',
    });
    const update = (state, patch = {}) => agent.objectives.updateTop({ state, status: 'running', ...patch });
    const logResult = (result) => {
        if (agent?.bot) skills.log(agent.bot, formatMiningPlan(result));
    };
    let finalResult = null;
    try {
        const plan = planMiningRun(agent, oreName, num);
        update('PLAN', { result: plan });
        if (!plan.ok && plan.reason !== 'missing_supplies') {
            agent.objectives.updateTop({ state: 'FAILED', status: 'failed', result: plan });
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
        const success = typeof result === 'object' ? result.ok : !!result;
        const mined = typeof result === 'object' ? result.mined : undefined;
        const target = typeof result === 'object' ? result.target : num;
        const reason = typeof result === 'object' ? result.reason : (result ? 'done' : 'failed');
        const details = typeof result === 'object' ? result.data : {};
        finalResult = objectiveResult({
            ok: success,
            reason: success ? 'done' : reason,
            message: success
                ? `Mining objective completed for ${oreName}.`
                : `Mining objective incomplete for ${oreName}: mined ${mined ?? 0}/${target}.`,
            data: { mined, target, ...details },
        });
        agent.objectives.updateTop({
            state: finalResult.ok ? 'DONE' : 'FAILED',
            status: finalResult.ok ? 'completed' : 'failed',
            result: finalResult,
        });
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
        }, 'objectives');
        agent.objectives.updateTop({
            state: 'FAILED',
            status: 'failed',
            result: finalResult,
            error: finalResult.message
        });
        logResult(finalResult);
        return formatMiningPlan(finalResult);
    } finally {
        if (agent.objectives.peek()?.id === frame.id) {
            agent.objectives.pop(finalResult);
        }
    }
}
