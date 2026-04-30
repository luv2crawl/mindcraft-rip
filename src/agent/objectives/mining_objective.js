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
    try {
        const plan = planMiningRun(agent, oreName, num);
        update('PLAN', { result: plan });
        if (!plan.ok && plan.reason !== 'missing_supplies') {
            agent.objectives.updateTop({ state: 'FAILED', status: 'failed', result: plan });
            skills.log(agent.bot, formatMiningPlan(plan));
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
        const finalResult = objectiveResult({
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
        if (finalResult.ok) {
            agent.objectives.pop(finalResult);
        }
        skills.log(agent.bot, formatMiningPlan(finalResult));
        return formatMiningPlan(finalResult);
    } catch (error) {
        const failed = objectiveResult({
            ok: false,
            reason: 'exception',
            message: `Mining objective threw: ${error?.message || String(error)}.`,
        });
        agent.objectives.updateTop({ state: 'FAILED', status: 'failed', result: failed, error: failed.message });
        throw error;
    }
}
