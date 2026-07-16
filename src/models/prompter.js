import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { ensureSessionMemory, formatSessionMemory } from '../agent/session_memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;
        this.prompt_sequence = 0;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = createModel({api: chat_model_profile.api});
        }

        this._attachTranscriptHooks([this.chat_model, this.code_model, this.vision_model]);

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples, this.agent);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples, this.agent);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    _memoryContext(messages = null) {
        const latestUser = (messages || []).slice().reverse().find(msg => msg.role === 'user')?.content || '';
        const latest = latestUser || (messages || []).slice().reverse().find(msg => msg.role !== 'system')?.content || '';
        const sessionMemory = ensureSessionMemory(this.agent);
        return {
            latestUserMessage: latestUser,
            latestMessage: latest,
            activeObjective: this.agent.objectives?.peek?.() || null,
            activeObjectiveSummary: sessionMemory.activeObjectiveSummary || null,
            currentAction: this.agent.actions?.currentActionLabel || '',
            currentCommandName: sessionMemory.currentCommandName || sessionMemory.lastCommand || '',
            currentResourceTarget: sessionMemory.currentResourceTarget || this._extractResourceTarget(latest),
            dimension: this.agent.bot?.game?.dimension ?? null,
            position: this.agent.bot?.entity?.position || null,
            lastCommandResultCode: sessionMemory.lastCommandResultCode || null,
            lastCommandResultData: sessionMemory.lastCommandResultData || {},
            taskLedgerSummary: this.agent.task_ledger?.summary?.() || '',
            sessionMemory,
        };
    }

    _extractResourceTarget(text = '') {
        const lower = String(text || '').toLowerCase();
        const commandMatch = lower.match(/!(?:mineore|planminingrun|prepareminingrun|findinstorage|restockfromstorage|takefromchest|depositall|craftrecipe|getcraftingplan)\("([^"]+)"/);
        if (commandMatch) return commandMatch[1];
        const intentMatch = lower.match(/\b(?:mine|find|restock|take|withdraw|craft|gather|collect|need|missing)\s+([a-z0-9_ -]{3,40})/);
        return intentMatch ? intentMatch[1].trim().replace(/\s+/g, '_') : null;
    }

    _attachTranscriptHooks(models) {
        const hooks = {
            retry: (data) => this.agent?.transcript?.record('model.retry', data, 'prompter', { stage: 'model' }),
            error: (data) => this.agent?.transcript?.record('model.error', data, 'prompter', { stage: 'model' }),
        };
        for (const m of models) {
            if (!m) continue;
            m.transcriptHooks = hooks;
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null, cachedReplacements=null, options={}) {
        const assembleStart = Date.now();
        const templateName = options.templateName || 'unknown';
        const initialLength = prompt?.length ?? 0;
        this.agent?.transcript?.record('prompt.assemble.start', {
            template_name: templateName,
            initial_length: initialLength,
            message_count: messages?.length ?? 0
        }, 'prompter', { stage: 'prompt' });
        const placeholderSnapshots = [];
        const snapshotPlaceholder = (name, value) => {
            const row = {
                name,
                length: typeof value === 'string' ? value.length : (value == null ? 0 : String(value).length),
            };
            if (settings.transcript_include_prompts && typeof value === 'string')
                row.value = value;
            placeholderSnapshots.push(row);
        };

        if (prompt.includes('$NAME')) {
            snapshotPlaceholder('$NAME', this.agent.name);
        }
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await this._cachedReplacement(cachedReplacements, '$STATS', async () => {
                let value = await getCommand('!stats').perform(this.agent) + '\n';
                value += await getCommand('!entities').perform(this.agent) + '\n';
                value += await getCommand('!nearbyBlocks').perform(this.agent);
                return value;
            });
            snapshotPlaceholder('$STATS', stats);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await this._cachedReplacement(cachedReplacements, '$INVENTORY', async () => {
                return await getCommand('!inventory').perform(this.agent);
            });
            snapshotPlaceholder('$INVENTORY', inventory);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            snapshotPlaceholder('$ACTION', this.agent.actions.currentActionLabel);
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS')) {
            const docs = getCommandDocs(this.agent);
            snapshotPlaceholder('$COMMAND_DOCS', docs);
            prompt = prompt.replaceAll('$COMMAND_DOCS', docs);
        }
        if (prompt.includes('$CODE_DOCS')) {
            const msgs = messages || [];
            const code_task_content = msgs.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            const code_docs = await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count);
            snapshotPlaceholder('$CODE_DOCS', code_docs);
            prompt = prompt.replaceAll('$CODE_DOCS', code_docs);
        }
        if (prompt.includes('$EXAMPLES') && examples !== null) {
            const exampleMessage = await this._cachedReplacement(cachedReplacements, '$EXAMPLES', async () => {
                return await examples.createExampleMessage(messages);
            });
            snapshotPlaceholder('$EXAMPLES', exampleMessage);
            prompt = prompt.replaceAll('$EXAMPLES', exampleMessage);
        }
        if (prompt.includes('$TEXT_MEMORY')) {
            const textMem = this.agent.history.memory || '';
            snapshotPlaceholder('$TEXT_MEMORY', textMem);
            prompt = prompt.replaceAll('$TEXT_MEMORY', textMem);
        }
        if (prompt.includes('$STRUCTURED_MEMORY')) {
            const memoryContext = this._memoryContext(messages);
            const structuredMemory = this.agent.memory_bank?.getPromptSummary?.(memoryContext) || '';
            const sessionMemory = formatSessionMemory(memoryContext.sessionMemory);
            const taskMemory = memoryContext.taskLedgerSummary || '';
            const memory = [taskMemory, sessionMemory, structuredMemory].filter(Boolean).join('\n');
            const block = memory ? `Structured memory:\n${memory}` : '';
            snapshotPlaceholder('$STRUCTURED_MEMORY', block);
            prompt = prompt.replaceAll('$STRUCTURED_MEMORY', block);
        }
        if (prompt.includes('$MEMORY')) {
            const textMemory = this.agent.history.memory || '';
            const includeStructured = options.includeStructuredMemory !== false;
            const memoryContext = includeStructured ? this._memoryContext(messages) : null;
            const structuredMemory = includeStructured
                ? this.agent.memory_bank?.getPromptSummary?.(memoryContext) || ''
                : '';
            const sessionMemory = includeStructured ? formatSessionMemory(memoryContext.sessionMemory) : '';
            const taskMemory = includeStructured ? (memoryContext.taskLedgerSummary || '') : '';
            const memory = [textMemory, (taskMemory || sessionMemory || structuredMemory) ? `Structured memory:\n${[taskMemory, sessionMemory, structuredMemory].filter(Boolean).join('\n')}` : '']
                .filter(Boolean)
                .join('\n');
            snapshotPlaceholder('$MEMORY', memory);
            prompt = prompt.replaceAll('$MEMORY', memory);
        }
        if (prompt.includes('$TO_SUMMARIZE')) {
            const ts = stringifyTurns(to_summarize);
            snapshotPlaceholder('$TO_SUMMARIZE', ts);
            prompt = prompt.replaceAll('$TO_SUMMARIZE', ts);
        }
        if (prompt.includes('$CONVO')) {
            const convo = 'Recent conversation:\n' + stringifyTurns(messages || []);
            snapshotPlaceholder('$CONVO', convo);
            prompt = prompt.replaceAll('$CONVO', convo);
        }
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            const self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            snapshotPlaceholder('$SELF_PROMPT', self_prompt);
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals || {}) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`;
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`;
            }
            goal_text = goal_text.trim();
            snapshotPlaceholder('$LAST_GOALS', goal_text);
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text);
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                blueprints = blueprints.slice(0, -2);
                snapshotPlaceholder('$BLUEPRINTS', blueprints);
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints);
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        this.agent?.transcript?.record('prompt.assemble.end', {
            template_name: templateName,
            duration_ms: Date.now() - assembleStart,
            prompt_length: prompt.length,
        }, 'prompter', { stage: 'prompt' });

        if (placeholderSnapshots.length > 0) {
            this.agent?.transcript?.record('prompt.placeholders.resolved', {
                placeholders: placeholderSnapshots,
            }, 'prompter', { stage: 'prompt', debug: true });
        }
        return prompt;
    }

    async _cachedReplacement(cache, key, createValue) {
        if (!cache) return await createValue();
        if (!cache.has(key)) {
            cache.set(key, await createValue());
        }
        return cache.get(key);
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        const currentPromptSequence = ++this.prompt_sequence;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (currentPromptSequence !== this.prompt_sequence) {
                return '';
            }

            let prompt = this.profile.conversing;
            const stableReplacements = new Map();
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples, [], null, stableReplacements);
            let generation;
            const start = Date.now();
            this.agent.transcript?.record('model.request', {
                kind: 'conversation',
                attempt: i + 1,
                model: this.chat_model?.model_name,
                message_count: messages?.length ?? 0,
                prompt,
                messages
            }, 'prompter', { stage: 'model' });

            try {
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');
                this.agent.transcript?.record('model.response', {
                    kind: 'conversation',
                    attempt: i + 1,
                    duration_ms: Date.now() - start,
                    response: generation
                }, 'prompter', { stage: 'model' });

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                this.agent.transcript?.record('model.error', {
                    kind: 'conversation',
                    attempt: i + 1,
                    duration_ms: Date.now() - start,
                    error: error?.message || String(error)
                }, 'prompter', { stage: 'model' });
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                this.agent.transcript?.record('model.discarded', {
                    kind: 'conversation',
                    reason: 'hallucinated_other_bot',
                    response: generation
                }, 'prompter', { stage: 'model' });
                continue;
            }

            if (currentPromptSequence !== this.prompt_sequence) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                this.agent.transcript?.record('model.discarded', {
                    kind: 'conversation',
                    reason: 'newer_message_received',
                    response: generation
                }, 'prompter', { stage: 'model' });
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        const start = Date.now();
        this.agent.transcript?.record('model.request', {
            kind: 'coding',
            model: this.code_model?.model_name,
            message_count: messages?.length ?? 0,
            prompt,
            messages
        }, 'prompter', { stage: 'model' });
        try {
            let resp = await this.code_model.sendRequest(messages, prompt);
            await this._saveLog(prompt, messages, resp, 'coding');
            this.agent.transcript?.record('model.response', {
                kind: 'coding',
                duration_ms: Date.now() - start,
                response: resp
            }, 'prompter', { stage: 'model' });
            return resp;
        } catch (error) {
            this.agent.transcript?.record('model.error', {
                kind: 'coding',
                duration_ms: Date.now() - start,
                error: error?.message || String(error)
            }, 'prompter', { stage: 'model' });
            throw error;
        } finally {
            this.awaiting_coding = false;
        }
    }

    async promptNewActionPlan(messages) {
        await this.checkCooldown();
        let prompt = this.profile.new_action_planning;
        if (!prompt) {
            prompt = 'Plan the requested !newAction. Return concise JSON with goal, sub_goals, selected_sub_goal, and selection_reason. Do not write code.\n$SELF_PROMPT\nSummarized memory:\'$MEMORY\'\n$STATS\n$INVENTORY\n$CODE_DOCS\n$EXAMPLES\nConversation:';
        }
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        const start = Date.now();
        this.agent.transcript?.record('model.request', {
            kind: 'new_action_plan',
            model: this.chat_model?.model_name,
            message_count: messages?.length ?? 0,
            prompt,
            messages
        }, 'prompter', { stage: 'model' });
        try {
            let resp = await this.chat_model.sendRequest(messages, prompt);
            await this._saveLog(prompt, messages, resp, 'newActionPlan');
            this.agent.transcript?.record('model.response', {
                kind: 'new_action_plan',
                duration_ms: Date.now() - start,
                response: resp
            }, 'prompter', { stage: 'model' });
            return resp;
        } catch (error) {
            this.agent.transcript?.record('model.error', {
                kind: 'new_action_plan',
                duration_ms: Date.now() - start,
                error: error?.message || String(error)
            }, 'prompter', { stage: 'model' });
            throw error;
        }
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize, null, null, { includeStructuredMemory: false });
        const start = Date.now();
        this.agent.transcript?.record('model.request', {
            kind: 'memory',
            model: this.chat_model?.model_name,
            message_count: to_summarize?.length ?? 0,
            prompt,
            messages: to_summarize
        }, 'prompter', { stage: 'model' });
        try {
            let resp = await this.chat_model.sendRequest([], prompt);
            await this._saveLog(prompt, to_summarize, resp, 'memSaving');
            this.agent.transcript?.record('model.response', {
                kind: 'memory',
                duration_ms: Date.now() - start,
                response: resp
            }, 'prompter', { stage: 'model' });
            if (resp?.includes('</think>')) {
                const [__, afterThink] = resp.split('</think>');
                resp = afterThink;
            }
            return resp;
        } catch (error) {
            this.agent.transcript?.record('model.error', {
                kind: 'memory',
                duration_ms: Date.now() - start,
                error: error?.message || String(error),
            }, 'prompter', { stage: 'model' });
            throw error;
        }
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, messages, null, messages);
        const start = Date.now();
        this.agent.transcript?.record('model.request', {
            kind: 'bot_responder',
            model: this.chat_model?.model_name,
            message_count: messages.length,
            prompt,
            messages
        }, 'prompter', { stage: 'model' });
        let res = await this.chat_model.sendRequest([], prompt);
        this.agent.transcript?.record('model.response', {
            kind: 'bot_responder',
            duration_ms: Date.now() - start,
            response: res
        }, 'prompter', { stage: 'model' });
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        const start = Date.now();
        this.agent.transcript?.record('model.request', {
            kind: 'vision',
            model: this.vision_model?.model_name,
            message_count: messages?.length ?? 0,
            image_bytes: imageBuffer?.length,
            prompt,
            messages
        }, 'prompter', { stage: 'model' });
        const res = await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
        this.agent.transcript?.record('model.response', {
            kind: 'vision',
            duration_ms: Date.now() - start,
            response: res
        }, 'prompter', { stage: 'model' });
        return res;
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!(settings.legacy_logs_enabled && settings.log_all_prompts))
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
