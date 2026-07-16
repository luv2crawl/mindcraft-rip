import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import settings from './settings.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const ACTIVE_STATUSES = new Set(['pending', 'running', 'active']);

function nowIso() {
    return new Date().toISOString();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function safeAgentName(name) {
    return String(name || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'unknown';
}

function makeTaskId(kind, target) {
    const suffix = [kind, target, Date.now()].filter(Boolean).join('_');
    return suffix.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

export function getTaskLedgerPath(agentName) {
    return path.join('.', 'bots', safeAgentName(agentName), 'task_ledger.json');
}

export function formatTaskLedgerSummary(ledger) {
    const current = ledger?.current || null;
    if (!current) return '';
    const progress = current.progress || {};
    const verified = progress.verified ?? current.evidence?.verified ?? null;
    const target = progress.target ?? current.targetCount ?? null;
    const progressText = verified != null && target != null ? ` verified=${verified}/${target}` : '';
    const next = current.nextAction ? ` next=${current.nextAction}` : '';
    const blocked = current.blockedReason ? ` blocker=${current.blockedReason}` : '';
    return `Task: ${current.status}/${current.phase || 'UNKNOWN'} ${current.userGoal || current.kind || 'task'}${progressText}${blocked}${next}`;
}

export class TaskLedger {
    constructor(agentName, agent = null, opts = {}) {
        this.agentName = safeAgentName(agentName);
        this.agent = agent;
        this.enabled = opts.enabled ?? settings.task_ledger_enabled ?? true;
        this.historyLimit = opts.historyLimit ?? settings.task_history_limit ?? 20;
        this.filePath = opts.filePath || getTaskLedgerPath(this.agentName);
        this.state = {
            current: null,
            history: [],
            updatedAt: null,
        };
    }

    load() {
        if (!this.enabled) return this;
        if (!existsSync(this.filePath)) {
            this._write();
            return this;
        }
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            this.state = {
                current: parsed.current || null,
                history: Array.isArray(parsed.history) ? parsed.history.slice(-this.historyLimit) : [],
                updatedAt: parsed.updatedAt || null,
            };
            if (ACTIVE_STATUSES.has(this.state.current?.status)) {
                this.interruptForRestart();
            }
        } catch (error) {
            let backupPath = null;
            try {
                backupPath = `${this.filePath}.corrupt-${Date.now()}`;
                renameSync(this.filePath, backupPath);
            } catch {
                backupPath = null;
            }
            this.state = {
                current: null,
                history: [],
                updatedAt: nowIso(),
                loadError: error?.message || String(error),
                corruptBackupPath: backupPath,
            };
            this._record('task.ledger.load_failure', { error, backupPath });
            this._write();
        }
        return this;
    }

    get current() {
        return this.state.current || null;
    }

    summary() {
        return formatTaskLedgerSummary(this.state);
    }

    start({ userGoal, kind, target = null, targetCount = null, phase = 'START', progress = {}, evidence = {}, nextAction = null } = {}) {
        if (!this.enabled) return null;
        this._archiveCurrentIfTerminal();
        const now = nowIso();
        this.state.current = {
            id: makeTaskId(kind || 'task', target),
            userGoal: userGoal || kind || 'task',
            kind: kind || 'task',
            target,
            targetCount,
            status: 'running',
            phase,
            progress,
            evidence,
            blockedReason: null,
            nextAction,
            startedAt: now,
            updatedAt: now,
        };
        this._persist('task.start', this.state.current);
        return this.current;
    }

    update(patch = {}) {
        if (!this.enabled || !this.state.current) return null;
        Object.assign(this.state.current, patch, {
            updatedAt: nowIso(),
        });
        this._persist('task.update', this.state.current);
        return this.current;
    }

    block(reason, patch = {}) {
        if (!this.enabled || !this.state.current) return null;
        Object.assign(this.state.current, patch, {
            status: 'blocked',
            blockedReason: reason || patch.blockedReason || 'blocked',
            updatedAt: nowIso(),
        });
        this._persist('task.blocked', this.state.current);
        return this.current;
    }

    complete(patch = {}) {
        if (!this.enabled || !this.state.current) return null;
        Object.assign(this.state.current, patch, {
            status: 'completed',
            phase: patch.phase || 'DONE',
            blockedReason: null,
            updatedAt: nowIso(),
            completedAt: nowIso(),
        });
        this._persist('task.complete', this.state.current);
        this._archiveCurrentIfTerminal();
        this._write();
        return null;
    }

    fail(reason, patch = {}) {
        if (!this.enabled || !this.state.current) return null;
        Object.assign(this.state.current, patch, {
            status: 'failed',
            blockedReason: reason || patch.blockedReason || 'failed',
            updatedAt: nowIso(),
            completedAt: nowIso(),
        });
        this._persist('task.fail', this.state.current);
        this._archiveCurrentIfTerminal();
        this._write();
        return null;
    }

    interruptForRestart() {
        if (!this.enabled || !this.state.current) return null;
        Object.assign(this.state.current, {
            status: 'interrupted',
            blockedReason: 'agent_restarted',
            nextAction: this.state.current.nextAction || '!taskStatus',
            updatedAt: nowIso(),
            evidence: {
                ...(this.state.current.evidence || {}),
                restart: true,
                restartAt: nowIso(),
            },
        });
        this._persist('task.interrupted', this.state.current);
        return this.current;
    }

    _archiveCurrentIfTerminal() {
        const current = this.state.current;
        if (!current || !TERMINAL_STATUSES.has(current.status)) return;
        this.state.history = [clone(current), ...(this.state.history || [])].slice(0, this.historyLimit);
        this.state.current = null;
        this.state.updatedAt = nowIso();
    }

    _persist(event, task) {
        this.state.updatedAt = nowIso();
        this._record(event, task);
        this._write();
    }

    _write() {
        if (!this.enabled) return;
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        renameSync(tmp, this.filePath);
    }

    _record(event, data) {
        this.agent?.transcript?.record(event, data, 'task_ledger', { stage: 'task' });
    }
}
