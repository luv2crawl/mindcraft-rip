const STOPPED = 0;
const ACTIVE = 1;
const PAUSED = 2;
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        let iteration = 0;
        let stopped_reason = null;
        while (!this.interrupt) {
            iteration++;
            this.agent.transcript?.record('self_prompter.iter.start', {
                iteration,
                idle_time_snapshot: this.idle_time,
                no_command_count,
                prompt: String(this.prompt || '').slice(0, 600),
            }, 'self_prompter', { stage: 'loop' });

            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            this.agent.transcript?.record('self_prompter.iter.end', {
                iteration,
                used_command,
            }, 'self_prompter', { stage: 'loop' });

            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    stopped_reason = 'no_command_3x';
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        const wasInterrupt = this.interrupt;
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
        const finalReason = stopped_reason ?? (wasInterrupt ? 'interrupt' : 'loop_exit');
        this.agent.transcript?.record('self_prompter.stopped', {
            reason: finalReason,
            final_state: this.state,
        }, 'self_prompter', { stage: 'loop' });
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop({ wait = true } = {}) {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt && !this.loop_active) {
            if (wait)
                this.interrupt = false;
            return;
        }
        if (this.interrupt && !wait)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        if (!wait)
            return;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.state = STOPPED;
        this.stopLoop({ wait: false });
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.state = PAUSED;
        this.stopLoop({ wait: false });
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop({ wait: false });
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
