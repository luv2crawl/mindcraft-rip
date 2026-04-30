import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptLogger } from '../src/agent/transcript_logger.js';

describe('TranscriptLogger', () => {
    test('appends valid JSONL records', () => {
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

    test('omits prompts by default and truncates long fields', () => {
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

            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.data.prompt, '[omitted: transcript_include_prompts=false]');
            assert.equal(entry.data.message, 'abcde...(truncated 5 chars)');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('handles circular data without throwing', () => {
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

            const entry = JSON.parse(readFileSync(filePath, 'utf8').trim());
            assert.equal(entry.data.self, '[circular]');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
