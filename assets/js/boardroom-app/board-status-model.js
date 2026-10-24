/**
 * The board's status (visible board, step 4; issue #75), DOM-free: the
 * status strip's text, the rate-limit wait countdown, quiet backend versus
 * broken connection, and the run-log gate that turns a run without
 * deliberation into one idle line.
 */

import {
    agentName,
    formatClock,
    formatDuration,
    PHASE_LABELS,
    WAITING_FOR_LABELS,
} from './trace-model.js';

/**
 * The contract: while any phase has run for more than 5 s, the page hears
 * something at least every 5 s. Past QUIET_AFTER_MS the page says how long
 * it has heard nothing; past BROKEN_AFTER_MS with no bytes at all (not even
 * a keepalive) it says the connection may be broken.
 */
export const QUIET_AFTER_MS = 5000;
export const BROKEN_AFTER_MS = 15000;

/**
 * The live wait of a heartbeat, or null. The countdown is measured from
 * the moment the heartbeat arrived (`wait_remaining_s`), so the browser's
 * clock offset does not matter.
 * @returns {{waitingFor: string, label: string, waitS: number|null, remainingS: number|null, endsAt: number|null, over: boolean}|null}
 */
export function liveWait(heartbeat, now = Date.now()) {
    if (!heartbeat?.entry) return null;
    const d = heartbeat.entry.details || {};
    const waitingFor = typeof d.waiting_for === 'string' ? d.waiting_for : null;
    if (!waitingFor) return null;
    const label = WAITING_FOR_LABELS[waitingFor] || waitingFor;
    const waitS = typeof d.wait_s === 'number' && Number.isFinite(d.wait_s) ? d.wait_s : null;
    let remainingS = null;
    let endsAt = null;
    if (typeof d.wait_remaining_s === 'number' && Number.isFinite(d.wait_remaining_s)) {
        endsAt = heartbeat.receivedAt + d.wait_remaining_s * 1000;
        remainingS = Math.max(0, (endsAt - now) / 1000);
    }
    return {
        waitingFor,
        label,
        waitS,
        remainingS,
        endsAt,
        over: remainingS != null && remainingS <= 0,
        speaker: typeof d.speaker === 'string' ? d.speaker : heartbeat.entry.agent,
    };
}

/** "Waiting for the model's rate limit to pass: 12 s left of a 20 s wait." */
export function waitText(wait) {
    if (!wait) return '';
    if (wait.remainingS == null) return `Waiting for ${wait.label}.`;
    if (wait.over) return `The ${wait.waitingFor === 'rate_limit' ? 'rate-limit wait' : 'wait'} is over; the request goes again.`;
    const left = `${Math.ceil(wait.remainingS)} s left`;
    const of = wait.waitS != null ? ` of a ${formatDuration(wait.waitS)} wait` : '';
    return `Waiting for ${wait.label}: ${left}${of}.`;
}

/**
 * What the status strip says.
 *
 * @param {object} input
 * @param {import('./trace-model.js').TraceStore} input.store
 * @param {boolean} input.runInFlight  - a non-hydrate run is streaming
 * @param {string|null} [input.stepSpeaker] - STEP_STARTED speaker, when no trace says
 * @param {object|null} [input.boardState] - hydrate `board_status` {running, reason, next_scheduled}
 * @param {number} [input.now]
 * @returns {{state: 'running'|'idle', text: string, elapsedText: string, speaker: string|null, phase: string|null, elapsedS: number|null, wait: object|null, waitText: string}}
 */
export function boardStatus({ store, runInFlight = false, stepSpeaker = null, boardState = null, now = Date.now() }) {
    const turn = store?.openTurn() || null;
    if (turn || runInFlight) {
        const hb = turn?.heartbeat || null;
        const entries = turn ? turn.sorted() : [];
        const last = entries[entries.length - 1] || null;
        const lastSpeaking = [...entries].reverse().find((e) => e.agent !== 'board' && e.phase !== 'routing') || null;
        const routing = [...entries].reverse().find((e) => e.phase === 'routing') || null;
        let speaker = hb?.entry?.details?.speaker || lastSpeaking?.agent || stepSpeaker || null;
        let phase = null;
        if (hb) phase = hb.entry.phase;
        else if (last) phase = last.phase;
        // A routing still `started` (no later routing entry) means the chair is choosing.
        if (routing && routing.state === 'started') {
            speaker = routing.agent;
            phase = 'routing';
        }
        let elapsedS = null;
        const hbElapsed = hb?.entry?.details?.elapsed_s;
        if (typeof hbElapsed === 'number' && Number.isFinite(hbElapsed)) {
            elapsedS = hbElapsed + (now - hb.receivedAt) / 1000;
        } else if (turn?.firstReceivedAt != null) {
            elapsedS = (now - turn.firstReceivedAt) / 1000;
        }
        const wait = liveWait(hb, now);
        const parts = ['The board is in session.'];
        if (speaker) parts.push(`Speaking: ${agentName(speaker)}.`);
        if (phase === 'routing') parts.push('Phase: routing (choosing who speaks next).');
        else if (phase) parts.push(`Phase: ${(PHASE_LABELS[phase] || phase).toLowerCase()}.`);
        else parts.push('Phase: not reported.');
        return {
            state: 'running',
            text: parts.join(' '),
            elapsedText: elapsedS != null ? `Running for ${formatDuration(Math.max(0, elapsedS))}.` : '',
            speaker,
            phase,
            elapsedS,
            wait,
            waitText: waitText(wait),
        };
    }
    return { ...idleStatus({ store, boardState }), elapsedText: '', speaker: null, phase: null, elapsedS: null, wait: null, waitText: '' };
}

/** "No round is running: <why>. Next round: <when>." from the trace or the hydrate. */
export function idleStatus({ store = null, boardState = null } = {}) {
    const idle = store?.lastIdle?.entry || null;
    let reason = null;
    let next = null;
    if (idle) {
        reason = typeof idle.details?.reason === 'string' ? idle.details.reason : null;
        next = typeof idle.details?.next_scheduled === 'string' ? idle.details.next_scheduled : null;
    }
    if (!idle && boardState && typeof boardState === 'object') {
        reason = typeof boardState.reason === 'string' ? boardState.reason : null;
        next = typeof boardState.next_scheduled === 'string' ? boardState.next_scheduled : null;
    }
    const known = !!idle || (boardState && typeof boardState === 'object');
    const nextMs = next ? Date.parse(next) : NaN;
    let text = `No round is running${reason ? `: ${reason}` : ''}.`;
    if (Number.isFinite(nextMs)) text += ` Next round: ${formatClock(nextMs)}.`;
    else if (known && next === null) text += ' No round is scheduled.';
    else text += ' Next round: not reported.';
    return { state: 'idle', text, reason, nextScheduled: Number.isFinite(nextMs) ? nextMs : null };
}

/**
 * Quiet backend or broken connection, while a run is open.
 * @param {object} input
 * @param {boolean} input.running
 * @param {number|null} input.lastEventAt - last AG-UI event or trace entry
 * @param {number|null} [input.lastBytesAt] - last bytes of the stream (keepalives count)
 * @param {boolean} [input.online] - navigator.onLine
 * @param {number} [input.now]
 * @returns {{seconds: number, connection: 'up'|'silent'|'offline', text: string}|null}
 */
export function silenceStatus({ running, lastEventAt, lastBytesAt = null, online = true, now = Date.now() }) {
    if (!running || lastEventAt == null) return null;
    const quietMs = now - lastEventAt;
    if (quietMs <= QUIET_AFTER_MS) return null;
    const seconds = Math.floor(quietMs / 1000);
    if (online === false) {
        return { seconds, connection: 'offline', text: `Heard nothing for ${seconds} s. Your browser is offline: the connection is down.` };
    }
    const bytesAt = Math.max(lastBytesAt ?? 0, lastEventAt);
    if (now - bytesAt > BROKEN_AFTER_MS) {
        return {
            seconds,
            connection: 'silent',
            text: `Heard nothing for ${seconds} s. The connection is open but silent for longer than the board allows (it sends something every 5 s): it may be broken.`,
        };
    }
    const keepalive = lastBytesAt != null && lastBytesAt > lastEventAt;
    return {
        seconds,
        connection: 'up',
        text: `Heard nothing for ${seconds} s. The connection is up${keepalive ? ' (keepalives are arriving)' : ''}; waiting for the board.`,
    };
}

const DELIBERATION_TYPES = new Set(['STEP_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START']);
const LIFECYCLE_TYPES = new Set(['RUN_STARTED', 'RUN_FINISHED', 'STATE_SNAPSHOT', 'MESSAGES_SNAPSHOT', 'STATE_DELTA']);

/**
 * Holds back a run's lifecycle log lines until the run holds deliberation
 * (a speaker step, speech, or a trace entry other than `idle`). A run that
 * ends without any is written as one idle line instead of "Run started /
 * State snapshot / Run finished".
 */
export class RunLogGate {
    constructor() {
        this.runs = new Map();
    }

    _run(runId, source) {
        let run = this.runs.get(runId);
        if (!run) {
            run = { source: source || null, deliberated: false, pending: [] };
            this.runs.set(runId, run);
        }
        return run;
    }

    /** A run held deliberation: its held lines are released. */
    deliberated(runId, source) {
        const run = this._run(runId, source);
        if (run.deliberated) return [];
        run.deliberated = true;
        const lines = run.pending;
        run.pending = [];
        return lines;
    }

    /**
     * Decide what to log for one AG-UI event of a run.
     * @param {object} event
     * @param {string} runId
     * @param {string} [source] - 'hydrate' for a page load, else a send
     * @param {object|null} line - what the log would write for it
     * @returns {{lines: object[], idle: boolean}} the lines to write now, and
     *   whether the run ended as an idle run (write one idle line).
     */
    onEvent(event, runId, source, line) {
        const type = String(event?.type || '');
        const run = this._run(runId, source);
        const lines = [];
        if (DELIBERATION_TYPES.has(type)) lines.push(...this.deliberated(runId, source));
        if (type === 'RUN_ERROR') {
            // A failure is always shown; nothing held back is needed to read it.
            run.pending = [];
            this.runs.delete(runId);
            if (line) lines.push(line);
            return { lines, idle: false };
        }
        if (type === 'RUN_FINISHED') {
            const idle = !run.deliberated;
            this.runs.delete(runId);
            if (!idle && line) lines.push(line);
            return { lines, idle };
        }
        if (!run.deliberated && LIFECYCLE_TYPES.has(type)) {
            if (line && run.source !== 'hydrate') run.pending.push(line);
            return { lines, idle: false };
        }
        if (line) lines.push(line);
        return { lines, idle: false };
    }

    /** A run that ended without a terminal event (aborted): forget it. */
    forget(runId) {
        this.runs.delete(runId);
    }
}
