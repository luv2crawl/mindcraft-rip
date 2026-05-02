let nextObjectiveId = 1;

export class ObjectiveStack {
    constructor(agent) {
        this.agent = agent;
        this.frames = [];
    }

    push({ type, args = {}, state = 'START', status = 'pending', result = null, error = null }) {
        const frame = {
            id: nextObjectiveId++,
            type,
            args,
            state,
            status,
            result,
            error,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.frames.push(frame);
        this.agent?.transcript?.record('objective.push', frame, 'objectives');
        return frame;
    }

    pop(result = null) {
        const frame = this.frames.pop() || null;
        if (frame) {
            frame.result = result ?? frame.result;
            if (frame.status !== 'completed' && frame.status !== 'failed') {
                frame.status = frame.result?.ok === false ? 'failed' : 'completed';
            }
            frame.updatedAt = Date.now();
            this.agent?.transcript?.record('objective.pop', frame, 'objectives');
        }
        return frame;
    }

    peek() {
        return this.frames[this.frames.length - 1] || null;
    }

    updateTop(patch) {
        const frame = this.peek();
        if (!frame) return null;
        Object.assign(frame, patch, { updatedAt: Date.now() });
        this.agent?.transcript?.record('objective.update', frame, 'objectives');
        return frame;
    }

    clear() {
        const count = this.frames.length;
        this.frames = [];
        this.agent?.transcript?.record('objective.clear', { count }, 'objectives');
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
