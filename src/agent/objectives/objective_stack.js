import { noteObjectiveUpdate } from '../session_memory.js';

let nextObjectiveId = 1;

export class ObjectiveStack {
    constructor(agent) {
        this.agent = agent;
        this.frames = [];
    }

    push({ type, args = {}, state = 'START', status = 'pending', result = null, error = null }) {
        const now = Date.now();
        const parent = this.peek();
        const frame = {
            id: nextObjectiveId++,
            type,
            args,
            state,
            status,
            result,
            error,
            parentId: parent?.id ?? null,
            stateEnteredAt: now,
            createdAt: now,
            updatedAt: now,
        };
        this.frames.push(frame);
        this.agent?.transcript?.record('objective.push', frame, 'objectives', { stage: 'objective' });
        noteObjectiveUpdate(this.agent, frame);
        return frame;
    }

    pop(result = null) {
        const frame = this.frames.pop() || null;
        if (frame) {
            frame.result = result ?? frame.result;
            if (frame.status !== 'completed' && frame.status !== 'failed') {
                const resultText = typeof frame.result === 'string' ? frame.result.trim() : '';
                const failed = frame.result == null ||
                    frame.result?.ok === false ||
                    /^FAILED:/i.test(resultText) ||
                    /^ERR_/i.test(resultText);
                frame.status = failed ? 'failed' : 'completed';
            }
            const now = Date.now();
            frame.updatedAt = now;
            frame.totalDurationMs = now - (frame.createdAt || now);
            this.agent?.transcript?.record('objective.pop', frame, 'objectives', { stage: 'objective' });
            noteObjectiveUpdate(this.agent, this.peek());
        }
        return frame;
    }

    peek() {
        return this.frames[this.frames.length - 1] || null;
    }

    updateTop(patch) {
        const frame = this.peek();
        if (!frame) return null;
        const now = Date.now();
        const fromState = frame.state;
        const fromStatus = frame.status;
        const stateEnteredAt = frame.stateEnteredAt || frame.createdAt || now;
        const stateChanged = patch && Object.prototype.hasOwnProperty.call(patch, 'state') && patch.state !== fromState;
        const statusChanged = patch && Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== fromStatus;
        Object.assign(frame, patch, { updatedAt: now });
        if (stateChanged) {
            frame.stateEnteredAt = now;
        }
        const enrichedPayload = {
            ...frame,
            transition: {
                fromState,
                toState: frame.state,
                fromStatus,
                toStatus: frame.status,
                stateChanged,
                statusChanged,
                timeInPrevStateMs: stateChanged ? now - stateEnteredAt : null,
                reason: patch?.reason ?? null
            }
        };
        this.agent?.transcript?.record('objective.update', enrichedPayload, 'objectives', { stage: 'objective' });
        noteObjectiveUpdate(this.agent, frame);
        return frame;
    }

    clear() {
        const count = this.frames.length;
        this.frames = [];
        this.agent?.transcript?.record('objective.clear', { count }, 'objectives', { stage: 'objective' });
        noteObjectiveUpdate(this.agent, null);
        return count;
    }

    serialize() {
        return JSON.parse(JSON.stringify(this.frames));
    }

    getSummary() {
        if (this.frames.length === 0) return 'Objective stack: empty.';
        const lines = ['Objective stack:'];
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            const argText = Object.entries(frame.args || {})
                .map(([key, value]) => `${key}=${value}`)
                .join(', ');
            lines.push(`- #${frame.id} ${frame.type}(${argText}) ${frame.status}/${frame.state}`);
        }
        return lines.join('\n');
    }
}
