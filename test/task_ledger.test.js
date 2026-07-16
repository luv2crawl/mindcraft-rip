import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { TaskLedger, formatTaskLedgerSummary } from '../src/agent/task_ledger.js';

test('TaskLedger persists current task and archives terminal tasks', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-task-ledger-'));
    try {
        const filePath = path.join(dir, 'task_ledger.json');
        const events = [];
        const ledger = new TaskLedger('bot', { transcript: { record: (...args) => events.push(args) } }, { filePath, historyLimit: 2 });

        ledger.start({ userGoal: 'mine 4 copper', kind: 'mine', target: 'copper', targetCount: 4, progress: { verified: 0, target: 4 } });
        ledger.update({ phase: 'BRANCH_MINE', progress: { mined: 2, verified: 1, target: 4 } });

        const saved = JSON.parse(readFileSync(filePath, 'utf8'));
        assert.equal(saved.current.target, 'copper');
        assert.equal(saved.current.phase, 'BRANCH_MINE');
        assert.match(formatTaskLedgerSummary(saved), /verified=1\/4/);

        ledger.complete({ progress: { mined: 4, verified: 4, target: 4 } });
        const completed = JSON.parse(readFileSync(filePath, 'utf8'));
        assert.equal(completed.current, null);
        assert.equal(completed.history.length, 1);
        assert.equal(completed.history[0].status, 'completed');
        assert.ok(events.some(([event]) => event === 'task.complete'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('TaskLedger marks active tasks interrupted on load after restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-task-ledger-'));
    try {
        const filePath = path.join(dir, 'task_ledger.json');
        const first = new TaskLedger('bot', null, { filePath });
        first.start({ userGoal: 'mine 4 copper', kind: 'mine', target: 'copper', targetCount: 4, phase: 'DESCEND' });

        const second = new TaskLedger('bot', null, { filePath }).load();

        assert.equal(second.current.status, 'interrupted');
        assert.equal(second.current.blockedReason, 'agent_restarted');
        assert.equal(second.current.phase, 'DESCEND');
        assert.equal(second.current.nextAction, '!taskStatus');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('TaskLedger backs up corrupt JSON before replacing it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-task-ledger-'));
    try {
        const filePath = path.join(dir, 'task_ledger.json');
        writeFileSync(filePath, '{bad json', 'utf8');

        const ledger = new TaskLedger('bot', null, { filePath }).load();
        const backups = readdirSync(dir).filter(name => name.includes('.corrupt-'));

        assert.equal(backups.length, 1);
        assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), '{bad json');
        assert.equal(existsSync(filePath), true);
        assert.match(ledger.state.loadError, /JSON/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
