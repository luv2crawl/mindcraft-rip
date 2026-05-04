import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import path from 'path';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { saveWorldMemory } from './world_memory.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
        this.pending_summary = Promise.resolve();
        this.summary_in_progress = false;
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        const memoryTurns = this._filterTurnsForMemory(turns);
        this.agent.transcript?.record('memory.summary.start', {
            turn_count: turns?.length ?? 0,
            filtered_turn_count: memoryTurns.length
        }, 'history');
        if (memoryTurns.length === 0) {
            this.agent.transcript?.record('memory.summary.skipped', {
                reason: 'no_durable_turns',
                turn_count: turns?.length ?? 0
            }, 'history');
            return true;
        }
        const timeoutMs = settings.memory_summary_timeout_ms ?? 20000;
        try {
            this.memory = await this._withTimeout(
                this.agent.prompter.promptMemSaving(memoryTurns),
                timeoutMs,
                `Memory summarization timed out after ${timeoutMs}ms.`
            );
        } catch (error) {
            console.error('Failed to summarize memory:', error?.message || error);
            this.agent.transcript?.record('memory.summary.failure', {
                error: error?.message || String(error),
                timeout_ms: timeoutMs
            }, 'history');
            return false;
        }

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
        this.agent.transcript?.record('memory.summary.end', {
            memory: this.memory
        }, 'history');
        return true;
    }

    _filterTurnsForMemory(turns = []) {
        return (turns || []).filter(turn => !this._isLowValueMemoryTurn(turn));
    }

    _isLowValueMemoryTurn(turn) {
        const content = String(turn?.content || '').trim();
        if (content.length === 0) return true;
        const lower = content.toLowerCase();
        if (turn?.role === 'system') {
            return [
                '(auto message)your previous action',
                'recent behaviors log:',
                '*command docs',
                'action output:',
                'code output:',
                '!!code threw exception!!',
                'code execution timed out',
                'command !',
                'ok: agent stopped',
                'err_interrupted:',
                'pathstopped:',
            ].some(pattern => lower.includes(pattern));
        }
        if (turn?.role === 'assistant') {
            return lower === '\t'
                || lower === 'received.'
                || lower.includes('!stop')
                || lower.includes('cancelling any remaining actions');
        }
        return false;
    }

    _withTimeout(promise, timeoutMs, timeoutMessage) {
        if (!timeoutMs || timeoutMs < 1) {
            return promise;
        }
        let timeout;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages && !this.summary_in_progress) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            this.summary_in_progress = true;
            this.pending_summary = this.pending_summary
                .catch(() => {})
                .then(async () => {
                    const summarized = await this.summarizeMemories(chunk);
                    if (!summarized) {
                        this.turns = chunk.concat(this.turns);
                        this.agent.transcript?.record('memory.summary.requeued', {
                            turn_count: chunk.length
                        }, 'history');
                    }
                })
                .catch((error) => {
                    console.error('Memory summary queue failed:', error?.message || error);
                    this.turns = chunk.concat(this.turns);
                })
                .finally(() => {
                    this.summary_in_progress = false;
                });
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            await this.flushPendingSummary();
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
            };
            this._atomicWriteJson(this.memory_fp, data);
            saveWorldMemory(this.agent);
            console.log('Saved memory to:', this.memory_fp);
            this.agent.transcript?.record('memory.save', {
                path: this.memory_fp,
                world_memory_path: this.agent.world_memory_path || null,
                turn_count: this.turns.length,
                has_self_prompt: data.self_prompt != null
            }, 'history');
        } catch (error) {
            console.error('Failed to save history:', error);
            this.agent.transcript?.record('memory.save.failure', {
                path: this.memory_fp,
                error: error?.message || String(error)
            }, 'history');
            throw error;
        }
    }

    async flushPendingSummary() {
        if (this.pending_summary) {
            await this.pending_summary.catch(() => {});
        }
    }

    _atomicWriteJson(filePath, data) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmp, filePath);
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            this.agent.transcript?.record('memory.load', {
                path: this.memory_fp,
                turn_count: this.turns.length,
                memory: this.memory
            }, 'history');
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            const backup = `${this.memory_fp}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            try {
                renameSync(this.memory_fp, backup);
            } catch {}
            this.memory = '';
            this.turns = [];
            this.agent.memory_bank?.loadJson?.({});
            this.agent.transcript?.record('memory.load.failure', {
                path: this.memory_fp,
                backup,
                error: error?.message || String(error)
            }, 'history');
            return null;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}
