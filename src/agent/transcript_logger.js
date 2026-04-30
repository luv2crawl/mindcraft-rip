import { mkdirSync, appendFileSync } from 'fs';
import path from 'path';
import settings from './settings.js';

export class TranscriptLogger {
    constructor(agentName, opts = {}) {
        this.agentName = agentName;
        this.enabled = opts.enabled ?? settings.transcript_logging ?? true;
        this.includePrompts = opts.includePrompts ?? settings.transcript_include_prompts ?? false;
        this.includeCode = opts.includeCode ?? settings.transcript_include_code ?? true;
        this.maxFieldChars = opts.maxFieldChars ?? settings.transcript_max_field_chars ?? 20000;
        this.sessionId = opts.sessionId || `${new Date().toISOString().replace(/[:.]/g, '-')}_${process.pid}`;
        this.filePath = opts.filePath || path.join('.', 'bots', agentName, 'transcripts', `${this.sessionId}.jsonl`);

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
            appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (error) {
            console.error('Transcript logging failed:', error?.message || error);
        }
    }

    _sanitize(value, seen = new WeakSet()) {
        if (value == null) return value;
        if (typeof value === 'string') return this._truncate(value);
        if (typeof value === 'number' || typeof value === 'boolean') return value;
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
            seen.delete(value);
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
