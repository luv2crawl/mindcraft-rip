import { mkdirSync, appendFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import path from 'path';
import settings from './settings.js';

export class TranscriptLogger {
    constructor(agentName, opts = {}) {
        this.agentName = agentName;
        this.enabled = opts.enabled ?? settings.transcript_logging ?? true;
        this.includePrompts = opts.includePrompts ?? settings.transcript_include_prompts ?? false;
        this.includeCode = opts.includeCode ?? settings.transcript_include_code ?? true;
        this.maxFieldChars = opts.maxFieldChars ?? settings.transcript_max_field_chars ?? 20000;
        this.flushIntervalMs = opts.flushIntervalMs ?? settings.transcript_flush_interval_ms ?? 100;
        this.maxQueueEntries = opts.maxQueueEntries ?? settings.transcript_max_queue_entries ?? 10000;
        this.sessionId = opts.sessionId || `${new Date().toISOString().replace(/[:.]/g, '-')}_${process.pid}`;
        this.filePath = opts.filePath || path.join('.', 'bots', agentName, 'transcripts', `${this.sessionId}.jsonl`);
        this.queue = [];
        this.flushTimer = null;
        this.flushPromise = Promise.resolve();
        this.droppedEntries = 0;

        if (this.enabled) {
            mkdirSync(path.dirname(this.filePath), { recursive: true });
        }
    }

    record(event, data = {}, source = null) {
        if (!this.enabled) return;
        try {
            const entry = {
                ts: new Date().toISOString(),
                session_id: this.sessionId,
                agent: this.agentName,
                event,
                source,
                data: this._sanitize(data, new WeakSet())
            };
            this._enqueue(JSON.stringify(entry) + '\n');
        } catch (error) {
            console.error('Transcript logging failed:', error?.message || error);
        }
    }

    async flush() {
        if (!this.enabled) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushPromise;
        const lines = this.queue.splice(0);
        if (lines.length === 0) return;
        try {
            await appendFile(this.filePath, lines.join(''), 'utf8');
        } catch (error) {
            console.error('Transcript flush failed:', error?.message || error);
        }
    }

    flushSync() {
        if (!this.enabled) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const lines = this.queue.splice(0);
        if (lines.length === 0) return;
        try {
            appendFileSync(this.filePath, lines.join(''), 'utf8');
        } catch (error) {
            console.error('Transcript flush failed:', error?.message || error);
        }
    }

    _enqueue(line) {
        if (this.queue.length >= this.maxQueueEntries) {
            this.queue.shift();
            this.droppedEntries++;
            if (this.droppedEntries === 1 || this.droppedEntries % 100 === 0) {
                const warning = {
                    ts: new Date().toISOString(),
                    session_id: this.sessionId,
                    agent: this.agentName,
                    event: 'transcript.queue.dropped',
                    source: 'transcript_logger',
                    data: {
                        dropped_entries: this.droppedEntries,
                        max_queue_entries: this.maxQueueEntries
                    }
                };
                this.queue.push(JSON.stringify(warning) + '\n');
            }
        }
        this.queue.push(line);
        this._scheduleFlush();
    }

    _scheduleFlush() {
        if (this.flushTimer || this.flushIntervalMs < 0) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushPromise = this.flushPromise
                .then(() => {
                    const lines = this.queue.splice(0);
                    if (lines.length === 0) return;
                    return appendFile(this.filePath, lines.join(''), 'utf8');
                })
                .catch((error) => {
                    console.error('Transcript flush failed:', error?.message || error);
                });
        }, this.flushIntervalMs);
        this.flushTimer.unref?.();
    }

    _sanitize(value, seen = new WeakSet()) {
        if (value == null) return value;
        if (typeof value === 'string') return this._truncate(value);
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Error) {
            return {
                name: value.name,
                message: this._truncate(value.message || ''),
                stack: this._truncate(value.stack || ''),
                code: value.code
            };
        }
        if (value instanceof Map) {
            return Object.fromEntries([...value.entries()].map(([key, item]) => [
                String(key),
                this._sanitize(item, seen)
            ]));
        }
        if (value instanceof Set) {
            return [...value.values()].map(item => this._sanitize(item, seen));
        }
        if (Array.isArray(value)) return value.map(item => this._sanitize(item, seen));
        if (typeof value === 'object') {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
            const out = {};
            for (const [key, item] of Object.entries(value)) {
                if (!this.includePrompts && (key === 'prompt' || key === 'systemMessage')) {
                    out[key] = '[omitted: transcript_include_prompts=false]';
                } else if (!this.includeCode && (key === 'code' || key === 'generatedCode')) {
                    out[key] = '[omitted: transcript_include_code=false]';
                } else {
                    out[key] = this._sanitize(item, seen);
                }
            }
            return out;
        }
        return String(value);
    }

    _truncate(text) {
        if (this.maxFieldChars > 0 && text.length > this.maxFieldChars) {
            return text.slice(0, this.maxFieldChars) + `...(truncated ${text.length - this.maxFieldChars} chars)`;
        }
        return text;
    }
}
