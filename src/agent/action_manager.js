import settings from './settings.js';
import assert from 'node:assert/strict';

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this._stuckPoll = null;
        this._stuckEmittedForAction = false;
    }

    _clearStuckWatch() {
        if (this._stuckPoll) {
            clearInterval(this._stuckPoll);
            this._stuckPoll = null;
        }
        this._stuckEmittedForAction = false;
    }

    async resumeAction(actionLabel = null, actionFn = null, timeout = 10) {
        if (typeof actionLabel === 'function') {
            throw new Error('resumeAction(actionFn, timeout) is no longer supported; pass actionLabel, actionFn, timeout.');
        }
        return this._executeResume(actionLabel, actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        try {
            this.timedout = false;
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');
            const actionStart = Date.now();
            this.agent.transcript?.record('action.start', {
                actionLabel,
                timeout
            }, 'action_manager', { stage: 'action' });

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            const stuckPollMs = settings.action_stuck_poll_ms ?? 10000;
            const stuckAfterMs = settings.action_stuck_after_ms ?? 45000;
            const bot = this.agent.bot;
            let lastMovedAt = Date.now();
            let anchor = bot.entity?.position
                ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
                : null;
            const invFingerprint = () => (bot.inventory?.items?.() || [])
                .map(it => `${it.name}:${it.count}`)
                .slice(0, 96)
                .join(',');
            let lastFp = invFingerprint();

            this._clearStuckWatch();
            this._stuckPoll = setInterval(() => {
                if (!this.executing || this._stuckEmittedForAction || !anchor)
                    return;
                const p = bot.entity?.position;
                if (!p)
                    return;
                const moved = Math.hypot(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z) > 0.25;
                const fpNow = invFingerprint();
                const invChanged = fpNow !== lastFp;
                if (moved || invChanged) {
                    lastMovedAt = Date.now();
                    anchor = { x: p.x, y: p.y, z: p.z };
                    lastFp = fpNow;
                }
                const since_ms = Date.now() - lastMovedAt;
                if (since_ms < stuckAfterMs)
                    return;
                this._stuckEmittedForAction = true;
                const sm = this.agent.session_memory || {};
                this.agent.task_ledger?.block?.('action_stuck', {
                    phase: this.agent.task_ledger.current?.phase || 'ACTION',
                    nextAction: '!taskStatus',
                    evidence: {
                        ...(this.agent.task_ledger.current?.evidence || {}),
                        stuck: {
                            since_ms,
                            threshold_ms: stuckAfterMs,
                            last_pos: anchor,
                            actionLabel,
                        },
                    },
                });
                if (settings.task_status_chat_enabled !== false) {
                    this.agent.openChat?.(`Blocked: current task appears stuck during ${actionLabel}. Use !taskStatus for details.`);
                }
                this.agent.transcript?.record('action.stuck', {
                    since_ms,
                    threshold_ms: stuckAfterMs,
                    last_pos: anchor,
                    last_inv_fingerprint_preview: `${fpNow.length}:${fpNow.slice(0, 140)}`,
                    current_command_name: sm.currentCommandName ?? sm.lastCommand ?? null,
                    current_action_label: actionLabel,
                }, 'action_manager', { stage: 'action' });
            }, stuckPollMs);
            if (typeof this._stuckPoll?.unref === 'function')
                this._stuckPoll.unref();

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.timedout = false;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            this.agent.transcript?.record('action.end', {
                actionLabel,
                duration_ms: Date.now() - actionStart,
                interrupted,
                timedout,
                output
            }, 'action_manager', { stage: 'action' });
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            const interrupted = this.agent.bot.interrupt_code;
            const timedout = this.timedout;
            if (interrupted && !timedout) {
                this.timedout = false;
                this.agent.clearBotLogs();
                this.agent.transcript?.record('action.end', {
                    actionLabel,
                    interrupted: true,
                    timedout: false,
                    output: ''
                }, 'action_manager', { stage: 'action' });
                return { success: false, message: '', interrupted: true, timedout: false };
            }
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            const errString = err?.toString?.() || String(err);
            const stack = err?.stack || '';

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + errString + '\n' +
                'Stack trace:\n' + stack + '\n';

            this.agent.clearBotLogs();
            this.timedout = false;
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            this.agent.transcript?.record('action.failure', {
                actionLabel,
                error: errString,
                message,
                interrupted,
                timedout
            }, 'action_manager', { stage: 'action' });
            return { success: false, message, interrupted, timedout };
        } finally {
            this._clearStuckWatch();
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output:\nOutput is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.transcript?.record('action.timeout', {
                actionLabel: this.currentActionLabel,
                timeout_mins: TIMEOUT_MINS
            }, 'action_manager', { stage: 'action' });
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
