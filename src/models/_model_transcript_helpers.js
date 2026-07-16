/**
 * Optional transcript hooks attached to model adapters by Prompter.
 * Keeps adapters free of transcript imports beyond these small notifies.
 */

export function notifyContextTruncateRetry(model, turnsRemainingAfterSlice, attemptIndex = undefined) {
    model?.transcriptHooks?.retry?.({
        reason: 'context_length_exceeded',
        action: 'truncate',
        turns_after_slice: turnsRemainingAfterSlice,
        ...(attemptIndex != null ? { attempt: attemptIndex } : {})
    });
}

export function notifyModelResponseFallback(model, err, detail = {}) {
    model?.transcriptHooks?.error?.({
        message: err?.message != null ? String(err.message) : String(err ?? ''),
        code: err?.code,
        stack: err?.stack,
        ...detail
    });
}

export function notifyModelRetryVisionFallback(model) {
    model?.transcriptHooks?.retry?.({
        reason: 'image_support',
        action: 'fallback',
        detail: 'vision_unsupported_prompt'
    });
}
