import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { appendFile } from 'fs/promises';
import path from 'path';
import settings from './settings.js';

const PROMPT_KEYS = new Set(['prompt', 'systemMessage', 'messages']);
const CODE_KEYS = new Set(['code', 'generatedCode']);

function safeAgentName(name) {
    const safe = String(name || 'unknown')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return safe || 'unknown';
}

export class TranscriptLogger {
    constructor(agentName, opts = {}) {
        this.agentName = String(agentName || 'unknown');
        this.safeAgentName = safeAgentName(agentName);
        this.enabled = opts.enabled ?? settings.transcript_logging ?? true;
        this.includePrompts = opts.includePrompts ?? settings.transcript_include_prompts ?? true;
        this.includeCode = opts.includeCode ?? settings.transcript_include_code ?? true;
        this.debugEnabled = opts.debugEnabled ?? settings.debug_logging ?? false;
        this.maxFieldChars = opts.maxFieldChars ?? settings.transcript_max_field_chars ?? 20000;
        this.flushIntervalMs = opts.flushIntervalMs ?? settings.transcript_flush_interval_ms ?? 100;
        this.maxQueueEntries = opts.maxQueueEntries ?? settings.transcript_max_queue_entries ?? 10000;
        this.sessionId = opts.sessionId || `${new Date().toISOString().replace(/[:.]/g, '-')}_${process.pid}`;
        this.transcriptFilePath = opts.filePath || path.join('.', 'bots', this.safeAgentName, 'transcripts', `${this.sessionId}.jsonl`);
        this.debugFilePath = opts.debugFilePath || path.join('.', 'bots', this.safeAgentName, 'debug', `${this.sessionId}.jsonl`);
        this.transcriptQueue = [];
        this.debugQueue = [];
        this.flushTimer = null;
        this.flushPromise = Promise.resolve();
        this.droppedEntries = 0;
        this.relayHook = null; // optional callback ({entry, debug}) for live tail
        this._traceContext = null;

        if (this.enabled) {
            mkdirSync(path.dirname(this.transcriptFilePath), { recursive: true });
        }
        if (this.enabled && this.debugEnabled) {
            mkdirSync(path.dirname(this.debugFilePath), { recursive: true });
        }
    }

    setRelayHook(fn) {
        this.relayHook = typeof fn === 'function' ? fn : null;
    }

    setTraceContext(id) {
        this._traceContext = typeof id === 'string' && id ? id : null;
    }

    clearTraceContext() {
        this._traceContext = null;
    }

    record(event, data = {}, source = null, opts = {}) {
        if (!this.enabled) return;
        const stage = opts.stage ?? null;
        const isDebug = opts.debug === true;
        if (isDebug && !this.debugEnabled) return;

        try {
            const trace_id = opts.trace_id ?? this._traceContext ?? null;
            const entry = {
                ts: new Date().toISOString(),
                session_id: this.sessionId,
                agent: this.agentName,
                event,
                source,
                stage,
                trace_id,
                data: this._sanitize(data, new WeakSet())
            };
            const line = JSON.stringify(entry) + '\n';
            this._enqueue(line, isDebug);
            if (this.relayHook) {
                try {
                    this.relayHook({ entry, debug: isDebug });
                } catch (err) {
                    // never let a relay failure break the logger
                    console.error('Transcript relay hook failed:', err?.message || err);
                }
            }
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
        await this._drainTo(this.transcriptQueue, this.transcriptFilePath);
        if (this.debugEnabled) {
            await this._drainTo(this.debugQueue, this.debugFilePath);
        }
    }

    flushSync() {
        if (!this.enabled) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this._drainSyncTo(this.transcriptQueue, this.transcriptFilePath);
        if (this.debugEnabled) {
            this._drainSyncTo(this.debugQueue, this.debugFilePath);
        }
    }

    async _drainTo(queue, filePath) {
        const lines = queue.slice();
        if (lines.length === 0) return;
        try {
            await appendFile(filePath, lines.join(''), 'utf8');
            queue.splice(0, lines.length);
        } catch (error) {
            console.error('Transcript flush failed:', error?.message || error);
        }
    }

    _drainSyncTo(queue, filePath) {
        const lines = queue.slice();
        if (lines.length === 0) return;
        try {
            appendFileSync(filePath, lines.join(''), 'utf8');
            queue.splice(0, lines.length);
        } catch (error) {
            console.error('Transcript flush failed:', error?.message || error);
        }
    }

    _enqueue(line, isDebug) {
        const queue = isDebug ? this.debugQueue : this.transcriptQueue;
        if (queue.length >= this.maxQueueEntries) {
            queue.shift();
            this.droppedEntries++;
            if (this.droppedEntries === 1 || this.droppedEntries % 100 === 0) {
                const warning = {
                    ts: new Date().toISOString(),
                    session_id: this.sessionId,
                    agent: this.agentName,
                    event: 'transcript.queue.dropped',
                    source: 'transcript_logger',
                    stage: 'system',
                    data: {
                        dropped_entries: this.droppedEntries,
                        max_queue_entries: this.maxQueueEntries,
                        debug: isDebug
                    }
                };
                queue.push(JSON.stringify(warning) + '\n');
            }
        }
        queue.push(line);
        this._scheduleFlush();
    }

    _scheduleFlush() {
        if (this.flushTimer || this.flushIntervalMs < 0) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushPromise = this.flushPromise
                .then(async () => {
                    await this._drainTo(this.transcriptQueue, this.transcriptFilePath);
                    if (this.debugEnabled) {
                        await this._drainTo(this.debugQueue, this.debugFilePath);
                    }
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
                if (!this.includePrompts && PROMPT_KEYS.has(key)) {
                    out[key] = '[omitted: transcript_include_prompts=false]';
                } else if (!this.includeCode && CODE_KEYS.has(key)) {
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

/**
 * Prune transcripts/ and debug/ files older than `retentionDays` days for a given bot.
 * Returns { transcriptsRemoved, debugRemoved }. Quiet on missing dirs.
 */
export function pruneOldTranscripts(agentName, retentionDays) {
    agentName = safeAgentName(agentName);
    const days = Number(retentionDays);
    const result = { transcriptsRemoved: 0, debugRemoved: 0 };
    if (!agentName || !Number.isFinite(days) || days <= 0) return result;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const dirs = [
        { path: path.join('.', 'bots', agentName, 'transcripts'), key: 'transcriptsRemoved' },
        { path: path.join('.', 'bots', agentName, 'debug'), key: 'debugRemoved' }
    ];
    for (const { path: dir, key } of dirs) {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of entries) {
            if (!name.endsWith('.jsonl')) continue;
            const full = path.join(dir, name);
            try {
                const stats = statSync(full);
                if (stats.mtimeMs < cutoff) {
                    unlinkSync(full);
                    result[key]++;
                }
            } catch {
                // ignore individual file errors
            }
        }
    }
    return result;
}
