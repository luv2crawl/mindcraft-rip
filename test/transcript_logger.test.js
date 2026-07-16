import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    existsSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptLogger, pruneOldTranscripts } from '../src/agent/transcript_logger.js';

describe('TranscriptLogger', () => {
    test('appends valid JSONL records', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-'));
        try {
            const filePath = path.join(dir, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath
            });

            logger.record('test.event', { value: 1 }, 'test');
            logger.record('test.second', { ok: true }, 'test');
            await logger.flush();

            const lines = readFileSync(filePath, 'utf8').trim().split('\n');
            assert.equal(lines.length, 2);
            const first = JSON.parse(lines[0]);
            assert.equal(first.session_id, 'session');
            assert.equal(first.agent, 'bot');
            assert.equal(first.event, 'test.event');
            assert.equal(first.source, 'test');
            assert.deepEqual(first.data, { value: 1 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('omits prompts by default and truncates long fields', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-'));
        try {
            const filePath = path.join(dir, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath,
                includePrompts: false,
                maxFieldChars: 5
            });

            logger.record('model.request', {
                prompt: 'secret prompt',
                message: 'abcdefghij'
            }, 'test');
            await logger.flush();

            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.data.prompt, '[omitted: transcript_include_prompts=false]');
            assert.equal(entry.data.message, 'abcde...(truncated 5 chars)');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('handles circular data without throwing', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-'));
        try {
            const filePath = path.join(dir, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath
            });
            const data = {};
            data.self = data;

            logger.record('circular', data, 'test');
            await logger.flush();

            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.data.self, '[circular]');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('serializes Error, BigInt, Map, and Set payloads', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-'));
        try {
            const filePath = path.join(dir, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath
            });
            const error = new Error('boom');
            error.code = 'EBOOM';

            logger.record('model.failure', {
                error,
                id: 10n,
                map: new Map([['key', 'value']]),
                set: new Set(['a', 'b'])
            }, 'test');
            await logger.flush();

            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.data.error.message, 'boom');
            assert.match(entry.data.error.stack, /Error: boom/);
            assert.equal(entry.data.error.code, 'EBOOM');
            assert.equal(entry.data.id, '10');
            assert.deepEqual(entry.data.map, { key: 'value' });
            assert.deepEqual(entry.data.set, ['a', 'b']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('flush writes queued records and record returns before disk write', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-'));
        try {
            const filePath = path.join(dir, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath,
                flushIntervalMs: -1
            });

            logger.record('queued', { ok: true }, 'test');
            assert.throws(() => readFileSync(filePath, 'utf8'));

            await logger.flush();
            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.event, 'queued');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('flush failure keeps queued records for a later retry', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-retry-'));
        try {
            const nested = path.join(dir, 'missing');
            const filePath = path.join(nested, 'session.jsonl');
            const logger = new TranscriptLogger('bot', {
                enabled: true,
                sessionId: 'session',
                filePath,
                flushIntervalMs: -1
            });
            rmSync(nested, { recursive: true, force: true });

            logger.record('queued', { ok: true }, 'test');
            await logger.flush();
            assert.equal(logger.transcriptQueue.length, 1);

            mkdirSync(nested, { recursive: true });
            await logger.flush();
            assert.equal(logger.transcriptQueue.length, 0);
            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.event, 'queued');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('pruneOldTranscripts removes stale jsonl by mtime', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-prune-'));
        try {
            const transcriptsDir = path.join(dir, 'bots', 'b1', 'transcripts');
            const debugDir = path.join(dir, 'bots', 'b1', 'debug');
            mkdirSync(transcriptsDir, { recursive: true });
            mkdirSync(debugDir, { recursive: true });
            const oldFile = path.join(transcriptsDir, 'old.jsonl');
            const newFile = path.join(transcriptsDir, 'fresh.jsonl');
            const oldDbg = path.join(debugDir, 'gone.jsonl');
            writeFileSync(oldFile, '{}\n');
            writeFileSync(newFile, '{}\n');
            writeFileSync(oldDbg, '{}\n');
            const stale = Date.now() - 14 * 24 * 60 * 60 * 1000;
            utimesSync(oldFile, new Date(stale), new Date(stale));
            utimesSync(oldDbg, new Date(stale), new Date(stale));
            utimesSync(newFile, new Date(), new Date());

            const origCwd = process.cwd();
            process.chdir(dir);
            try {
                const r = pruneOldTranscripts('b1', 7);
                assert.equal(r.transcriptsRemoved, 1);
                assert.equal(r.debugRemoved, 1);
                assert.equal(existsSync(oldFile), false);
                assert.equal(existsSync(oldDbg), false);
                assert.equal(existsSync(newFile), true);
            } finally {
                process.chdir(origCwd);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('normalizes agent names for default transcript paths', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-safe-'));
        const origCwd = process.cwd();
        try {
            process.chdir(dir);
            const logger = new TranscriptLogger('../escape/bot', {
                enabled: true,
                sessionId: 'session',
                flushIntervalMs: -1
            });

            assert.equal(logger.agentName, '../escape/bot');
            assert.equal(logger.safeAgentName, 'escape_bot');
            assert.equal(
                path.normalize(logger.transcriptFilePath),
                path.normalize(path.join('.', 'bots', 'escape_bot', 'transcripts', 'session.jsonl'))
            );
        } finally {
            process.chdir(origCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('dot-only agent names cannot escape the bots directory', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-transcript-dot-'));
        const origCwd = process.cwd();
        try {
            process.chdir(dir);
            const logger = new TranscriptLogger('..', {
                enabled: true,
                sessionId: 'session',
                flushIntervalMs: -1
            });

            assert.equal(logger.safeAgentName, 'unknown');
            assert.equal(
                path.normalize(logger.transcriptFilePath),
                path.normalize(path.join('.', 'bots', 'unknown', 'transcripts', 'session.jsonl'))
            );
        } finally {
            process.chdir(origCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
