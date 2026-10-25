/**
 * Liveness (visible board, follow-up 3; issue #78), DOM-free. The relay
 * sends `boardroom_liveness` as an AG-UI CUSTOM event about every 5 s while
 * a run is open. It is never a log line: it feeds the status strip (last
 * phase heard, last agent, time since the last word, elapsed time, whether
 * the board is running, and a rate-limit wait) and resets the quiet clock.
 *
 * The value is read tolerantly (a flat object, or a trace-like heartbeat
 * with `details`); a field the server does not send is "not reported":
 *
 *   running, phase, agent (or speaker), elapsed_s, since_last_word_s,
 *   waiting_for, wait_s, wait_remaining_s, wait_ends_at (+ server_now), turn_id
 *
 * The end of a rate-limit wait is taken from, in order: `wait_remaining_s`
 * (counted from arrival, so the browser's clock does not matter);
 * `wait_ends_at` (shifted by `server_now` when sent); or, when only the
 * length `wait_s` is sent, the first heartbeat that reported that wait plus
 * its length (shown as "about").
 */

import { heartbeatRecord } from './trace-model.js';

export const LIVENESS_EVENT = 'boardroom_liveness';

const TEXT_MAX = 40;

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function text(v) {
    return typeof v === 'string' && v ? v.slice(0, TEXT_MAX) : null;
}

/** One liveness value, normalised, or null when it is not an object. */
export function normalizeLiveness(value) {
    if (!isPlainObject(value)) return null;
    const v = { ...(isPlainObject(value.details) ? value.details : {}), ...value };
    const agent = text(v.agent ?? v.speaker ?? v.last_agent);
    return {
        running: typeof v.running === 'boolean' ? v.running : null,
        phase: text(v.phase ?? v.last_phase),
        agent: agent ? agent.toLowerCase().replace(/^boardroom-/, '') : null,
        elapsedS: num(v.elapsed_s),
        sinceLastWordS: num(v.since_last_word_s),
        waitingFor: text(v.waiting_for),
        waitS: num(v.wait_s),
        waitRemainingS: num(v.wait_remaining_s),
        waitEndsAt: typeof v.wait_ends_at === 'string' ? v.wait_ends_at.slice(0, 40) : null,
        serverNow: typeof v.server_now === 'string' ? v.server_now.slice(0, 40) : null,
        turnId: typeof v.turn_id === 'string' ? v.turn_id.slice(0, 128) : null,
    };
}

/** A liveness as a heartbeat record `{entry, receivedAt, waitStartedAt}` for the strip. */
export function livenessHeartbeat(liveness, receivedAt, prev = null) {
    const details = {};
    if (liveness.agent) details.speaker = liveness.agent;
    if (liveness.elapsedS != null) details.elapsed_s = liveness.elapsedS;
    if (liveness.sinceLastWordS != null) details.since_last_word_s = liveness.sinceLastWordS;
    if (liveness.waitingFor) details.waiting_for = liveness.waitingFor;
    if (liveness.waitS != null) details.wait_s = liveness.waitS;
    if (liveness.waitRemainingS != null) details.wait_remaining_s = liveness.waitRemainingS;
    if (liveness.waitEndsAt) {
        const ends = Date.parse(liveness.waitEndsAt);
        const now = liveness.serverNow ? Date.parse(liveness.serverNow) : NaN;
        if (Number.isFinite(ends)) {
            details.wait_ends_at_ms = Number.isFinite(now) ? receivedAt + (ends - now) : ends;
        }
    }
    const entry = {
        agent: liveness.agent || 'board',
        phase: liveness.phase,
        live: true,
        details,
    };
    return heartbeatRecord(entry, receivedAt, prev);
}

/** What the page has heard of the board's liveness: the latest message and how many. */
export class LivenessState {
    constructor() {
        this.count = 0;
        this.last = null;      // heartbeat record, or null
        this.running = null;   // the last `running` the server sent
    }

    receive(value, receivedAt = Date.now()) {
        const liveness = normalizeLiveness(value);
        if (!liveness) return null;
        this.count += 1;
        this.running = liveness.running;
        this.last = livenessHeartbeat(liveness, receivedAt, this.last);
        return liveness;
    }

    /** The run ended: the last message no longer says the board is running. */
    endRun() {
        this.last = null;
        this.running = null;
    }
}
