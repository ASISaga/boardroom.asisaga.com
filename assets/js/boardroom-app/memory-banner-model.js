/**
 * The memory banner (visible board, step 4; issue #75), DOM-free. The
 * hydrate's STATE_SNAPSHOT says whether the board's memory (the Mind) could
 * be read, as a `memory` object (proposed to the Function App, step 3):
 *
 *   {"status": "ok" | "empty" | "unavailable",
 *    "cause": "<cause class>", "affects": ["history", "grounding"],
 *    "retrying": true, "next_retry_at": "<ISO UTC>"}
 *
 * An older backend sends only `live_only: true` and `live_only_reason`; the
 * banner then says what it can and marks the rest "not reported".
 */

import { CAUSE_CLASSES, causeLabel, formatClock } from './trace-model.js';

export const HISTORY_EMPTY_TEXT = 'No history yet: the board has not met in this room. Start the conversation!';
export const RETRY_NOW_LABEL = 'Retry now';

// A scheduled re-read never comes sooner than this, nor later than this.
export const MIN_AUTO_RETRY_MS = 5000;
export const MAX_AUTO_RETRY_MS = 10 * 60 * 1000;
// With no server retry scheduled, the page reads history again itself this often.
export const PAGE_RETRY_MS = 60 * 1000;
export const HISTORY_UNAVAILABLE_EMPTY_TEXT = 'No past turns shown: history could not be read (see the banner above).';

const AFFECTS = ['history', 'grounding'];

/** The hydrate's memory report, normalised, or null when it says nothing. */
export function memoryReport(state) {
    if (!state || typeof state !== 'object') return null;
    const m = state.memory;
    if (m && typeof m === 'object' && typeof m.status === 'string') {
        const affects = Array.isArray(m.affects) ? m.affects.filter((a) => AFFECTS.includes(a)) : null;
        const nextMs = typeof m.next_retry_at === 'string' ? Date.parse(m.next_retry_at) : NaN;
        return {
            status: m.status,
            cause: typeof m.cause === 'string' && m.cause ? m.cause : null,
            affects,
            retrying: m.retrying === true,
            nextRetryAt: Number.isFinite(nextMs) ? nextMs : null,
            legacy: false,
        };
    }
    if ('live_only' in state) {
        if (state.live_only !== true) return { status: 'ok', cause: null, affects: [], retrying: false, nextRetryAt: null, legacy: true };
        const reason = typeof state.live_only_reason === 'string' ? state.live_only_reason : null;
        return {
            status: 'unavailable',
            cause: CAUSE_CLASSES.includes(reason) ? reason : 'memory_unavailable',
            reportedReason: reason && !CAUSE_CLASSES.includes(reason) ? reason : null,
            // The legacy banner said "history and grounding are off".
            affects: null,
            retrying: null,
            nextRetryAt: null,
            legacy: true,
        };
    }
    return null;
}

function affectsText(affects) {
    if (!affects) return 'Affected: not reported (an older server says history and grounding are off).';
    const history = affects.includes('history');
    const grounding = affects.includes('grounding');
    if (history && grounding) return 'Affected: history (past turns are not shown) and grounding (the board speaks without its memory).';
    if (history) return 'Affected: history (past turns are not shown). Grounding is on.';
    if (grounding) return 'Affected: grounding (the board speaks without its memory). History loaded.';
    return 'Affected: nothing reported.';
}

function retryText(report, now) {
    if (report.retrying === null) return 'Retry: not reported.';
    if (!report.retrying) return 'No retry is under way.';
    if (report.nextRetryAt == null) return 'A retry is under way.';
    const inS = Math.max(0, Math.ceil((report.nextRetryAt - now) / 1000));
    return `A retry is under way: next at ${formatClock(report.nextRetryAt)} (in ${inS} s).`;
}

/**
 * The banner, or null when there is nothing wrong. "No history yet" is not
 * a banner (see historyEmptyText).
 * @returns {{cause: string|null, text: string, causeText: string, affectsText: string, retryText: string, nextRetryAt: number|null}|null}
 */
export function memoryBanner(state, now = Date.now()) {
    const report = memoryReport(state);
    if (!report || report.status !== 'unavailable') return null;
    const cause = report.cause;
    const reported = report.reportedReason ? ` (reported as “${report.reportedReason}”)` : '';
    const causeText = `History could not be read: ${causeLabel(cause) || 'cause not reported'}${cause ? ` [${cause}]` : ''}${reported}.`;
    const affects = affectsText(report.affects);
    const retry = retryText(report, now);
    return {
        cause,
        causeText,
        affectsText: affects,
        retryText: retry,
        text: `${causeText} ${affects} ${retry}`,
        nextRetryAt: report.retrying ? report.nextRetryAt : null,
    };
}

/** True when the read succeeded and the company has no turns yet. */
export function historyEmpty(state) {
    return memoryReport(state)?.status === 'empty';
}

/**
 * The delay before the page re-reads history itself, or null when there is
 * no banner. It follows the server's next retry (plus a second for it to
 * land); with none scheduled, the page checks again every PAGE_RETRY_MS, so
 * the banner clears itself once the cause clears.
 */
export function autoRetryDelay(banner, now = Date.now()) {
    if (!banner) return null;
    if (banner.nextRetryAt == null) return PAGE_RETRY_MS;
    const delay = banner.nextRetryAt - now + 1000;
    return Math.min(MAX_AUTO_RETRY_MS, Math.max(MIN_AUTO_RETRY_MS, delay));
}

/** The page's own re-read, when the server has none scheduled. */
export function pageRetryText(banner, pageRetryAt, now = Date.now()) {
    if (!banner || banner.nextRetryAt != null || pageRetryAt == null) return '';
    const inS = Math.max(0, Math.ceil((pageRetryAt - now) / 1000));
    return `The page reads history again at ${formatClock(pageRetryAt)} (in ${inS} s).`;
}
