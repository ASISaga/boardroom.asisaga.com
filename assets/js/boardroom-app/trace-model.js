/**
 * The turn trace (visible board, step 4 of 4; issue #75): DOM-free model of
 * the `boardroom.trace.v1` entries a turn produces about its own work, as
 * fixed by boardroom-orchestration step 1 (docs/turn-trace.md).
 *
 * A trace is not speech. It carries counts, sizes, durations, handles and
 * cause classes only. Every string from an entry is untrusted: views set
 * it as textContent, never as HTML.
 *
 * - normalizeTraceEntry: validate and normalise one wire entry (or null).
 * - TraceStore: entries per turn, the audience check, heartbeats, history.
 * - buildTimeline: one turn as routing lines, speaker groups and board rows.
 * - failureCard / turnSummary: the owner's wording, operator detail apart.
 * - traceText: a turn's trace as plain text for an operator to share.
 */

import { BOARDROOM_ROSTER } from './constants.js';

export const TRACE_SCHEMA = 'boardroom.trace.v1';

/**
 * AG-UI CUSTOM event name that carries one trace entry as its `value`
 * (proposed to the Function App, step 3). A bare SSE frame with
 * `schema: "boardroom.trace.v1"` and no `type` (O's own wire) is accepted too.
 */
export const TRACE_EVENT = 'boardroom_trace';

/**
 * Hydrate STATE_SNAPSHOT key carrying the stored traces of past turns
 * (proposed to step 3): `[{turn_id, entries: [...], trace_unavailable?,
 * trace?: {requested, arrived, withheld, lost}}]`.
 */
export const TRACE_HISTORY_KEY = 'turn_traces';

export const TRACE_PHASES = [
    'turn_opened', 'routing', 'memory_read', 'context_built', 'model_call',
    'write_back', 'outcome', 'turn_closed', 'capacity', 'idle',
];
export const TRACE_STATES = ['started', 'progress', 'finished', 'failed', 'skipped'];
export const TRACE_AUDIENCES = ['owner', 'operator'];

/** The shared cause classes, plus `cancelled` (added by step 1). */
export const CAUSE_CLASSES = [
    'rate_limited', 'budget_exhausted', 'timed_out', 'memory_unavailable',
    'memory_conflict', 'refused', 'invalid_reply', 'internal', 'cancelled',
];

/** Plain-language reading of each cause class. */
export const CAUSE_LABELS = {
    rate_limited: 'the model is limiting requests (rate limit)',
    budget_exhausted: 'its time for this turn ran out',
    timed_out: 'an answer did not come in time',
    memory_unavailable: 'the board’s memory could not be reached',
    memory_conflict: 'the board’s memory changed while it was being used',
    refused: 'the request was refused',
    invalid_reply: 'the reply could not be read',
    internal: 'an internal error',
    cancelled: 'the turn was cancelled',
};

/** What the board does next (`next`), in the owner's words. */
export const NEXT_LABELS = {
    continue: 'The board moves on to the next speaker.',
    stop: 'The board stopped the turn here.',
    retry: 'The board tries again.',
    none: 'Nothing further happens in this turn.',
};

export const PHASE_LABELS = {
    turn_opened: 'Turn opened',
    routing: 'Routing',
    memory_read: 'Reading memory',
    context_built: 'Building context',
    model_call: 'Model call',
    write_back: 'Write-back',
    outcome: 'Outcome',
    turn_closed: 'Turn closed',
    capacity: 'Capacity',
    idle: 'Idle',
};

export const STATE_LABELS = {
    started: 'running',
    progress: 'running',
    finished: 'done',
    failed: 'failed',
    skipped: 'skipped',
    unended: 'no end reported',
};

/** Heartbeat `waiting_for`, in the owner's words. */
export const WAITING_FOR_LABELS = {
    rate_limit: 'the model’s rate limit to pass',
    model_reply: 'the model’s reply',
    agent: 'the speaker',
    memory: 'the board’s memory',
    chair: 'the chair',
    board: 'the board',
};

/** `turn_closed.details.reason`, in the owner's words. */
export const CLOSE_REASON_LABELS = {
    no_more_speakers: 'the chair closed the discussion',
    failed_speaker: 'a speaker could not answer',
    budget: 'the turn ran out of time',
    budget_exhausted: 'the turn ran out of time',
    empty_queue: 'there was nothing left to discuss',
    cancelled: 'the turn was cancelled',
};

/** The phases inside one speaker's turn, in the contract's order. */
export const SPEAKER_PHASE_ORDER = ['memory_read', 'context_built', 'model_call', 'write_back', 'outcome'];

export const TRACE_UNAVAILABLE = 'Trace unavailable';
export const NOT_REPORTED = 'Not reported';

// Step 1's bounds: 480-character summaries, 300 entries per turn.
const MAX_SUMMARY_CHARS = 480;
const MAX_ENTRIES_PER_TURN = 300;
// Turn ids are Evt turn ids (UUIDs); anything else is not a trace entry.
const TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const AGENT_PATTERN = /^[a-z0-9._-]{1,40}$/;

const ROSTER_NAMES = new Map(BOARDROOM_ROSTER.map((a) => [a.agentId, a.name]));
const CHAIR = 'founder';

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseTime(v) {
    if (typeof v !== 'string' || !v) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
}

/** A role's display name: `CFO`, `Founder`; `the board` for the board. */
export function agentName(agent) {
    const id = String(agent || '').toLowerCase();
    if (!id || id === 'board') return 'The board';
    return ROSTER_NAMES.get(id) || id.toUpperCase();
}

/** `0.6 s`, `17 s`, `2 min 5 s`; an empty string for no duration. */
export function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const total = Math.round(seconds);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return sec ? `${min} min ${sec} s` : `${min} min`;
}

/** Local wall-clock time (the page's time zone), HH:MM:SS. */
export function formatClock(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
}

/** Plain-language reading of a cause class (an unknown class is shown as is). */
export function causeLabel(cause) {
    return CAUSE_LABELS[cause] || (cause ? String(cause) : '');
}

/**
 * Validate one wire entry and return its normalised form, or null when it
 * is not a `boardroom.trace.v1` entry the page can render. Strings are
 * capped; unknown keys are dropped.
 */
export function normalizeTraceEntry(raw) {
    if (!isPlainObject(raw) || raw.schema !== TRACE_SCHEMA) return null;
    if (typeof raw.turn_id !== 'string' || !TURN_ID_PATTERN.test(raw.turn_id)) return null;
    if (!TRACE_PHASES.includes(raw.phase) || !TRACE_STATES.includes(raw.state)) return null;
    if (!TRACE_AUDIENCES.includes(raw.audience)) return null;
    const live = raw.live === true;
    let n = null;
    if (!live) {
        if (!Number.isInteger(raw.n) || raw.n < 1) return null;
        n = raw.n;
    }
    let agent = String(raw.agent ?? 'board').toLowerCase().replace(/^boardroom-/, '');
    if (!AGENT_PATTERN.test(agent)) agent = 'board';
    return {
        schema: TRACE_SCHEMA,
        turnId: raw.turn_id,
        n,
        agent,
        phase: raw.phase,
        state: raw.state,
        startedAt: parseTime(raw.started_at),
        startedAtText: typeof raw.started_at === 'string' ? raw.started_at.slice(0, 40) : null,
        durationS: finiteOrNull(raw.duration_s),
        summary: typeof raw.summary === 'string' ? raw.summary.slice(0, MAX_SUMMARY_CHARS) : '',
        details: isPlainObject(raw.details) ? { ...raw.details } : {},
        audience: raw.audience,
        source: typeof raw.source === 'string' ? raw.source.slice(0, 20) : null,
        cause: typeof raw.cause === 'string' && raw.cause ? raw.cause.slice(0, 40) : null,
        next: typeof raw.next === 'string' && raw.next ? raw.next.slice(0, 20) : null,
        live,
        after: live && Number.isInteger(raw.after) ? raw.after : null,
        truncated: raw.truncated === true,
    };
}

/** The trace entry an AG-UI event carries, raw (not yet validated), or undefined. */
export function traceEntryOf(event) {
    if (!isPlainObject(event)) return undefined;
    if (event.type === 'CUSTOM' && event.name === TRACE_EVENT) return event.value ?? null;
    if (event.type == null && event.schema === TRACE_SCHEMA) return event;
    return undefined;
}

/** The turn id embedded in a message id (`<turn_id>:<role>`), or null. */
export function turnIdOfMessage(messageId) {
    const id = String(messageId ?? '').replace(/^snapshot-/, '');
    const cut = id.lastIndexOf(':');
    if (cut <= 0) return null;
    const turnId = id.slice(0, cut);
    return TURN_ID_PATTERN.test(turnId) ? turnId : null;
}

/** The role in a message id (`<turn_id>:<role>`), or null. */
export function roleOfMessage(messageId) {
    const id = String(messageId ?? '');
    const cut = id.lastIndexOf(':');
    return cut > 0 ? id.slice(cut + 1).toLowerCase() : null;
}

/** What a heartbeat is waiting on, as a key: the same key means the same wait. */
export function waitKey(entry) {
    const d = entry?.details || {};
    if (typeof d.waiting_for !== 'string') return null;
    return `${d.waiting_for}|${d.speaker ?? entry.agent}|${d.wait_s ?? ''}`;
}

/**
 * A heartbeat record `{entry, receivedAt, waitStartedAt}`. When only the
 * length of a wait is sent (`wait_s`), its end is counted from the first
 * heartbeat that reported that same wait.
 */
export function heartbeatRecord(entry, receivedAt, prev = null) {
    const key = waitKey(entry);
    const waitStartedAt = key && prev && waitKey(prev.entry) === key
        ? (prev.waitStartedAt ?? prev.receivedAt)
        : receivedAt;
    return { entry, receivedAt, waitStartedAt };
}

/**
 * Why a turn has no trace, from a report of `{requested, arrived, withheld,
 * lost}` (the run result's `trace`, or a history item's `trace`): the board
 * sent none, the server withheld it for the person's role, or the stored
 * trace was lost. Null when the report cannot tell ("unavailable").
 * @returns {{kind: 'withheld'|'lost'|'not_sent'|'not_requested', text: string}|null}
 */
export function traceAbsence(report) {
    if (!isPlainObject(report)) return null;
    if (report.withheld === true) {
        return { kind: 'withheld', text: 'the server withheld this turn’s trace for your role' };
    }
    if (report.lost === true) {
        return { kind: 'lost', text: 'the stored trace of this turn was lost' };
    }
    if (report.requested === false) {
        return { kind: 'not_requested', text: 'this turn’s trace was not requested' };
    }
    if (report.arrived === false) {
        return { kind: 'not_sent', text: 'the board sent no trace for this turn' };
    }
    return null;
}

/** One turn's trace: numbered entries, the latest heartbeat, and what is missing. */
export class TurnTrace {
    constructor(turnId) {
        this.turnId = turnId;
        this.entries = new Map();   // n -> entry (numbered, stored entries only)
        this.heartbeat = null;      // {entry, receivedAt}: the latest live entry
        this.invalid = 0;           // entries that could not be read
        this.unavailable = null;    // reason string when the trace is unavailable
        this.absence = null;        // 'withheld' | 'lost' | 'not_sent' | 'not_requested' | null (cannot tell)
        this.serverError = null;    // {code, message} of the run's RUN_ERROR, as sent
        this.live = false;          // received on a live stream (not history)
        this.firstReceivedAt = null;
        this.lastReceivedAt = null;
        this.order = 0;             // arrival order among turns
    }

    add(entry, receivedAt) {
        if (this.firstReceivedAt == null) this.firstReceivedAt = receivedAt;
        this.lastReceivedAt = receivedAt;
        if (entry.live) {
            this.heartbeat = heartbeatRecord(entry, receivedAt, this.heartbeat);
            return;
        }
        if (this.entries.size >= MAX_ENTRIES_PER_TURN && !this.entries.has(entry.n)) return;
        this.entries.set(entry.n, entry);
        // A trace that did arrive is no longer "unavailable".
        this.unavailable = null;
        this.absence = null;
        // A numbered entry after the heartbeat moves the state on.
        if (this.heartbeat && (this.heartbeat.entry.after ?? 0) < entry.n) this.heartbeat = null;
    }

    sorted() {
        return [...this.entries.values()].sort((a, b) => a.n - b.n);
    }

    find(phase, predicate = () => true) {
        return this.sorted().filter((e) => e.phase === phase && predicate(e));
    }

    get opened() { return this.find('turn_opened')[0] || null; }

    get closed() {
        const closes = this.find('turn_closed');
        return closes[closes.length - 1] || null;
    }

    /** True when the turn held no deliberation: idle entries only. */
    get idleOnly() {
        const all = this.sorted();
        return all.length > 0 && all.every((e) => e.phase === 'idle');
    }

    get isOpen() {
        return !!this.opened && !this.closed && !this.unavailable;
    }

    /**
     * Numbers missing from 1..max. Only meaningful on an operator stream:
     * an owner stream has gaps where operator entries were. Numbers after
     * a truncation marker are the cut's, not lost entries.
     */
    missingNumbers() {
        const all = this.sorted();
        if (!all.length) return [];
        const cut = all.find((e) => e.details?.trace_truncated === true);
        const max = cut ? cut.n : all[all.length - 1].n;
        const missing = [];
        for (let n = 1; n <= max; n += 1) {
            if (!this.entries.has(n)) missing.push(n);
        }
        return missing;
    }
}

/**
 * The page's trace: one TurnTrace per turn id, with the audience check.
 * An owner session keeps owner entries only, whatever arrives: the server
 * withholds operator entries, and the page never renders one it was sent
 * by mistake (it counts them in `droppedOperator`).
 */
export class TraceStore {
    /** @param {{operator?: boolean}} [options] */
    constructor({ operator = false } = {}) {
        this.operator = operator === true;
        this.turns = new Map();
        this.droppedOperator = 0;
        this.invalid = 0;
        this.lastIdle = null;   // the latest idle entry, {entry, receivedAt}
        this._order = 0;
    }

    setOperator(operator) {
        this.operator = operator === true;
        if (this.operator) return;
        // Leaving operator mode drops what an owner may not see.
        for (const turn of this.turns.values()) {
            for (const [n, entry] of [...turn.entries]) {
                if (entry.audience !== 'owner') turn.entries.delete(n);
            }
            if (turn.heartbeat && turn.heartbeat.entry.audience !== 'owner') turn.heartbeat = null;
        }
    }

    turn(turnId) {
        let turn = this.turns.get(turnId);
        if (!turn) {
            turn = new TurnTrace(turnId);
            turn.order = (this._order += 1);
            this.turns.set(turnId, turn);
        }
        return turn;
    }

    /**
     * Receive one raw entry.
     * @returns {{entry: object|null, turn: TurnTrace|null, dropped: null|'invalid'|'audience'}}
     */
    receive(raw, { receivedAt = Date.now(), live = true } = {}) {
        const entry = normalizeTraceEntry(raw);
        if (!entry) {
            this.invalid += 1;
            const turnId = isPlainObject(raw) && typeof raw.turn_id === 'string' && TURN_ID_PATTERN.test(raw.turn_id)
                ? raw.turn_id : null;
            if (turnId) this.turn(turnId).invalid += 1;
            return { entry: null, turn: turnId ? this.turns.get(turnId) : null, dropped: 'invalid' };
        }
        if (entry.audience !== 'owner' && !this.operator) {
            this.droppedOperator += 1;
            return { entry: null, turn: null, dropped: 'audience' };
        }
        const turn = this.turn(entry.turnId);
        if (live) turn.live = true;
        turn.add(entry, receivedAt);
        if (entry.phase === 'idle' && !entry.live) this.lastIdle = { entry, receivedAt };
        return { entry, turn, dropped: null };
    }

    /**
     * Load a history read: `[{turn_id, entries, trace_unavailable?}]`. A turn
     * without a usable trace is marked "trace unavailable", not an error.
     * @returns {string[]} the turn ids loaded, in order.
     */
    loadHistory(turns, { receivedAt = Date.now() } = {}) {
        if (!Array.isArray(turns)) return [];
        const ids = [];
        for (const item of turns) {
            if (!isPlainObject(item) || typeof item.turn_id !== 'string' || !TURN_ID_PATTERN.test(item.turn_id)) {
                this.invalid += 1;
                continue;
            }
            const turn = this.turn(item.turn_id);
            ids.push(item.turn_id);
            const absence = traceAbsence(item.trace);
            if (item.trace_unavailable === true || !Array.isArray(item.entries)) {
                if (!turn.entries.size) this.markUnavailable(item.turn_id, absence?.text || 'the history read returned no trace for this turn', absence?.kind || null);
                continue;
            }
            for (const raw of item.entries) {
                // Stored entries are numbered; a heartbeat is never stored.
                if (isPlainObject(raw) && raw.live === true) continue;
                this.receive(raw, { receivedAt, live: false });
            }
            if (!turn.entries.size && !turn.invalid) {
                turn.unavailable = absence?.text || 'the history read returned an empty trace for this turn';
                turn.absence = absence?.kind || null;
            }
        }
        return ids;
    }

    /** Mark a turn's trace unavailable (it never arrived, or could not be read). */
    markUnavailable(turnId, reason, absence = null) {
        if (!turnId || !TURN_ID_PATTERN.test(turnId)) return null;
        const turn = this.turn(turnId);
        if (!turn.entries.size && (!turn.unavailable || (absence && !turn.absence))) {
            turn.unavailable = reason;
            turn.absence = absence;
        }
        return turn;
    }

    /** The latest turn still open on a live stream, or null. */
    openTurn() {
        let latest = null;
        for (const turn of this.turns.values()) {
            if (turn.live && turn.isOpen && (!latest || turn.order > latest.order)) latest = turn;
        }
        return latest;
    }
}

function entryVisible(entry, { operator, operatorView }) {
    if (entry.audience === 'owner') return true;
    return operator === true && operatorView !== false;
}

function newRow(entry) {
    return {
        phase: entry.phase,
        agent: entry.agent,
        state: entry.state,
        audience: entry.audience,
        startedAt: entry.startedAt,
        durationS: entry.durationS,
        summary: entry.summary,
        cause: entry.cause,
        next: entry.next,
        details: { ...entry.details },
        notReported: entry.details?.not_reported === true,
        truncatedCut: entry.details?.trace_truncated === true,
        first: entry.n,
        pos: entry.n,
        ns: [entry.n],
        running: entry.state === 'started' || entry.state === 'progress',
    };
}

function mergeInto(row, entry) {
    row.ns.push(entry.n);
    row.pos = entry.phase === 'routing' ? entry.n : row.pos;
    if (entry.state === 'progress') {
        if (entry.summary) row.summary = entry.summary;
        Object.assign(row.details, entry.details);
        return;
    }
    row.state = entry.state;
    row.audience = entry.audience === 'owner' || row.audience === 'owner' ? 'owner' : 'operator';
    if (entry.summary) row.summary = entry.summary;
    Object.assign(row.details, entry.details);
    row.cause = entry.cause ?? row.cause;
    row.next = entry.next ?? row.next;
    row.running = false;
    if (entry.durationS != null) {
        row.durationS = entry.durationS;
    } else if (row.startedAt != null && entry.startedAt != null && entry.startedAt >= row.startedAt) {
        row.durationS = (entry.startedAt - row.startedAt) / 1000;
    }
}

/** The routing line: "The chair passed it to the CFO: <reason>". */
export function routingText(row) {
    const d = row.details || {};
    const by = String(d.by || row.agent || CHAIR).toLowerCase();
    const who = by === CHAIR ? 'The chair' : agentName(by);
    if (row.running) return `${who} is choosing who speaks next.`;
    const reason = typeof d.reason === 'string' && d.reason ? `: ${d.reason}` : '';
    if (d.terminate === true || !d.next_speaker) return `${who} closed the discussion${reason}`;
    return `${who} passed it to the ${agentName(d.next_speaker)}${reason}`;
}

/**
 * The failure card of a speaker group: the owner's wording once, and the
 * operator detail only for an operator session.
 */
export function failureCard(group, { operator = false } = {}) {
    const owner = group.outcomes.find((e) => e.audience === 'owner' && e.state === 'failed')
        || null;
    const op = group.outcomes.find((e) => e.audience === 'operator' && e.state === 'failed') || null;
    const failed = owner || op;
    if (!failed) return null;
    const name = agentName(group.agent);
    const cause = failed.cause || op?.cause || null;
    const next = failed.next || op?.next || null;
    const text = owner?.summary
        || `${name} could not answer${cause ? `: ${causeLabel(cause)}` : ''}. ${NEXT_LABELS[next] || ''}`.trim();
    let detail = null;
    if (operator === true && op) {
        const d = op.details || {};
        detail = {
            modelRequests: finiteOrNull(d.model_requests),
            rateLimited: finiteOrNull(d.rate_limited),
            waits: finiteOrNull(d.waits),
            waitS: finiteOrNull(d.wait_s),
            waitsS: Array.isArray(d.waits_s) ? d.waits_s.filter((v) => typeof v === 'number') : [],
            elapsedS: finiteOrNull(d.elapsed_s ?? op.durationS),
            budgetS: finiteOrNull(d.budget_s),
            errorType: typeof d.error_type === 'string' ? d.error_type : null,
            summary: op.summary,
        };
    }
    return {
        agent: group.agent,
        title: `${name} could not answer`,
        text,
        cause,
        causeLabel: causeLabel(cause),
        next,
        nextLabel: NEXT_LABELS[next] || '',
        detail,
    };
}

/** The turn's summary from its `turn_closed` entry, or null while it is open. */
export function turnSummary(turn) {
    const closed = turn.closed;
    if (!closed) return null;
    const d = closed.details || {};
    const spoke = Array.isArray(d.spoke) ? d.spoke.map(agentName) : [];
    const reason = typeof d.reason === 'string' ? d.reason : null;
    const parts = [
        `Ended: ${CLOSE_REASON_LABELS[reason] || reason || 'reason not reported'}.`,
        `Spoke: ${spoke.length ? spoke.join(', ') : 'nobody'}.`,
    ];
    const calls = finiteOrNull(d.model_requests);
    const limited = finiteOrNull(d.rate_limited);
    if (calls != null) parts.push(`Model calls: ${calls}${limited ? ` (${limited} rate-limited)` : ''}.`);
    const waitS = finiteOrNull(d.wait_s);
    parts.push(`Waiting: ${waitS != null ? formatDuration(waitS) : NOT_REPORTED.toLowerCase()}.`);
    parts.push(`Total: ${closed.durationS != null ? formatDuration(closed.durationS) : NOT_REPORTED.toLowerCase()}.`);
    const dropped = finiteOrNull(d.dropped);
    if (dropped) parts.push(`${dropped} trace entr${dropped === 1 ? 'y was' : 'ies were'} dropped at the limit.`);
    return {
        state: closed.state,
        reason,
        reasonText: CLOSE_REASON_LABELS[reason] || reason || null,
        spoke,
        modelRequests: calls,
        rateLimited: limited,
        waitS,
        durationS: closed.durationS,
        cause: closed.cause,
        text: parts.join(' '),
    };
}

/**
 * One turn as a timeline: the opening, then routing lines, speaker groups
 * and board rows in the order they happened, then the summary.
 *
 * @param {TurnTrace} turn
 * @param {{operator?: boolean, operatorView?: boolean}} [options]
 */
export function buildTimeline(turn, { operator = false, operatorView = true } = {}) {
    const visibility = { operator, operatorView };
    const all = turn.sorted();
    const visible = all.filter((e) => entryVisible(e, visibility));
    const closed = !!turn.closed;

    // Pair each terminal entry with the latest open `started` of the same
    // agent and phase; outcomes are collected per speaker for the card.
    const rows = [];
    const open = new Map();
    const outcomes = [];
    let opened = null;
    let close = null;
    for (const entry of visible) {
        if (entry.phase === 'turn_opened') { opened = entry; continue; }
        if (entry.phase === 'turn_closed') { close = entry; continue; }
        if (entry.phase === 'outcome' && entry.agent !== 'board') { outcomes.push(entry); continue; }
        const key = `${entry.agent}|${entry.phase}`;
        const stack = open.get(key) || [];
        if (entry.state === 'started') {
            const row = newRow(entry);
            rows.push(row);
            stack.push(row);
            open.set(key, stack);
            continue;
        }
        const target = stack[stack.length - 1];
        if (target) {
            mergeInto(target, entry);
            if (!target.running) stack.pop();
            continue;
        }
        rows.push(newRow(entry));
    }
    // In a closed (or unavailable) turn nothing is still running.
    if (closed || turn.unavailable || !turn.live) {
        for (const row of rows) {
            if (row.running) { row.running = false; row.state = 'unended'; }
        }
    }

    rows.sort((a, b) => a.pos - b.pos);
    for (const outcome of outcomes) {
        rows.push({ outcomeOf: outcome.agent, pos: outcome.n, entry: outcome });
    }
    rows.sort((a, b) => a.pos - b.pos);

    const items = [];
    let group = null;
    for (const row of rows) {
        if (row.outcomeOf) {
            if (!group || group.agent !== row.outcomeOf) {
                group = { kind: 'speaker', agent: row.outcomeOf, rows: [], outcomes: [], first: row.pos };
                items.push(group);
            }
            group.outcomes.push(row.entry);
            continue;
        }
        if (row.phase === 'routing') {
            items.push({ kind: 'routing', row, text: routingText(row) });
            group = null;
            continue;
        }
        if (row.phase === 'idle') {
            items.push({ kind: 'idle', row, text: row.summary || 'No round is running.' });
            group = null;
            continue;
        }
        if (row.truncatedCut) {
            items.push({ kind: 'truncated', row });
            continue;
        }
        if (row.agent === 'board') {
            items.push({ kind: 'board', row });
            group = null;
            continue;
        }
        if (!group || group.agent !== row.agent) {
            group = { kind: 'speaker', agent: row.agent, rows: [], outcomes: [], first: row.pos };
            items.push(group);
        }
        group.rows.push(row);
    }
    for (const item of items) {
        if (item.kind !== 'speaker') continue;
        item.rows.sort((a, b) => (SPEAKER_PHASE_ORDER.indexOf(a.phase) - SPEAKER_PHASE_ORDER.indexOf(b.phase))
            || (a.pos - b.pos));
        item.name = agentName(item.agent);
        const outcome = item.outcomes.find((e) => e.audience === 'owner') || item.outcomes[0] || null;
        item.state = outcome ? (outcome.details?.outcome || outcome.state) : (item.rows.some((r) => r.running) ? 'running' : null);
        item.durationS = outcome?.durationS ?? null;
        item.failure = failureCard(item, { operator: operator === true && operatorView !== false });
    }

    // On an operator stream a gap in the numbering is a lost entry.
    const missing = operator === true && operatorView !== false ? turn.missingNumbers() : [];
    if (missing.length) items.push({ kind: 'missing', numbers: missing });

    let status = 'running';
    if (turn.unavailable && !all.length) status = 'unavailable';
    else if (turn.idleOnly) status = 'idle';
    else if (closed) status = 'closed';
    else if (!turn.live) status = 'incomplete';

    const od = opened?.details || {};
    return {
        turnId: turn.turnId,
        status,
        unavailable: turn.unavailable,
        absence: turn.absence,
        serverError: turn.serverError,
        invalid: turn.invalid,
        opened: opened ? {
            summary: opened.summary,
            trigger: typeof od.trigger === 'string' ? od.trigger : null,
            agendaItem: typeof od.agenda_item === 'string' ? od.agenda_item : null,
            title: typeof od.title === 'string' ? od.title : null,
            roster: Array.isArray(od.roster) ? od.roster.map(agentName) : [],
            startedAt: opened.startedAt,
        } : null,
        openedMissing: !opened && !turn.idleOnly && all.length > 0,
        items,
        summary: close ? turnSummary(turn) : null,
        closedMissing: !close && (!turn.live || !!turn.unavailable) && !turn.idleOnly && all.length > 0,
        heartbeat: turn.heartbeat,
    };
}

/** The failure cards of a turn, one per failing speaker. */
export function failureCards(timeline) {
    return timeline.items.filter((i) => i.kind === 'speaker' && i.failure).map((i) => i.failure);
}

function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * True when a speech bubble's text only repeats a failure card (the
 * failing speaker's speech is the card's first sentence), so the failure
 * is shown once, on the card.
 */
export function repeatsFailure(text, card) {
    const said = normalizeText(text);
    const wording = normalizeText(card?.text);
    if (!said || !wording) return false;
    return wording.startsWith(said) || said.startsWith(wording);
}

/** True when a speech bubble's text is only a routing reason. */
export function repeatsRouting(text, routingRow) {
    const said = normalizeText(text);
    const reason = normalizeText(routingRow?.details?.reason);
    return !!said && said === reason;
}

/**
 * Prompt size of a `context_built` entry (operators): size against the
 * budget, included against existing per kind of content, and each prompt
 * section's name and size. Null when the entry carries none of it.
 */
export function contextSize(details) {
    if (!isPlainObject(details)) return null;
    const num = (k) => finiteOrNull(details[k]);
    const kinds = new Map();
    const sections = [];
    for (const [key, value] of Object.entries(details)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        let m = /^section\.(.+)_chars$/.exec(key);
        if (m) { sections.push({ name: m[1].slice(0, 40), chars: value }); continue; }
        m = /^(.+)_(total|included)$/.exec(key);
        if (m) {
            const kind = kinds.get(m[1]) || { kind: m[1].slice(0, 40), total: null, included: null };
            kind[m[2]] = value;
            kinds.set(m[1], kind);
        }
    }
    const chars = num('chars');
    const tokens = num('tokens_est');
    const budget = num('budget_tokens');
    if (chars == null && tokens == null && !kinds.size && !sections.length) return null;
    const parts = [];
    if (chars != null || tokens != null) {
        parts.push(`Prompt: ${chars != null ? `${chars} characters` : 'size not reported'}`
            + `${tokens != null ? `, about ${tokens} tokens` : ''}`
            + `${budget != null ? ` of a ${budget}-token budget` : ''}.`);
    }
    if (kinds.size) {
        parts.push(`Included: ${[...kinds.values()].map((k) => `${k.kind} ${k.included ?? '?'} of ${k.total ?? '?'}`).join(', ')}.`);
    }
    if (sections.length) {
        parts.push(`Sections: ${sections.map((s) => `${s.name} ${s.chars} characters`).join(', ')}.`);
    }
    return { chars, tokens, budget, kinds: [...kinds.values()], sections, text: parts.join(' ') };
}

/** A phase row's technical detail (operators) as `key: value` lines. */
export function detailLines(details) {
    if (!isPlainObject(details)) return [];
    return Object.entries(details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(String).join(', ') : String(v)}`);
}

const COPY_WITHHELD_DETAILS = new Set(['reason', 'title']);

function copyValue(v) {
    if (Array.isArray(v)) return `[${v.map(copyValue).join(',')}]`;
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v.slice(0, 80));
    if (typeof v === 'object') return '{…}';
    return String(v);
}

/**
 * A turn's trace as plain text, for an operator to share. Entries carry no
 * company content by contract; free-text details (`reason`, `title`) and the
 * routing summary, which quotes the chair's reason, are left out all the
 * same, and speech is never included. Null for an owner session.
 */
export function traceText(turn, { operator = false, now = Date.now() } = {}) {
    if (operator !== true || !turn) return null;
    const lines = [`Boardroom turn ${turn.turnId}: trace (${TRACE_SCHEMA}), copied ${new Date(now).toISOString()}`];
    if (turn.unavailable) lines.push(`${TRACE_UNAVAILABLE}: ${turn.unavailable}`);
    for (const e of turn.sorted()) {
        const summary = e.phase === 'routing'
            ? `${e.details?.by || e.agent} -> ${e.details?.next_speaker || (e.state === 'started' ? '(choosing)' : '(none)')}`
            : e.summary;
        const details = Object.entries(e.details || {})
            .filter(([k]) => !COPY_WITHHELD_DETAILS.has(k))
            .map(([k, v]) => `${k}=${copyValue(v)}`)
            .join(' ');
        lines.push([
            `#${e.n}`,
            e.startedAtText || '-',
            e.agent,
            e.phase,
            e.state,
            e.durationS != null ? `${e.durationS}s` : '-',
            e.audience,
            e.cause ? `cause=${e.cause}` : '',
            e.next ? `next=${e.next}` : '',
            `| ${summary}`,
            details ? `| ${details}` : '',
        ].filter(Boolean).join(' '));
    }
    const missing = turn.missingNumbers();
    if (missing.length) lines.push(`Missing entries: ${missing.map((n) => `#${n}`).join(', ')}`);
    if (turn.invalid) lines.push(`Unreadable entries: ${turn.invalid}`);
    return lines.join('\n');
}

/** The cause class a server sent, in words and as sent: `an internal error [internal]`. */
export function serverClassText(code) {
    if (typeof code !== 'string' || !code) return `${NOT_REPORTED.toLowerCase()}`;
    return CAUSE_LABELS[code] ? `${CAUSE_LABELS[code]} [${code}]` : `[${code}]`;
}

/**
 * A failure with no trace card (the stream carried no trace): the run's own
 * RUN_ERROR becomes the one card. `bubbleText` is what the failing speaker
 * said (the card's wording); the server's class and message are shown as
 * sent, and never replaced by a guess.
 * @param {{error: {code?: string, message?: string}, speaker?: string|null, bubbleText?: string}} input
 */
export function serverFailureCard({ error, speaker = null, bubbleText = '' }) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    const said = String(bubbleText || '').trim();
    const code = typeof error?.code === 'string' && error.code ? error.code : null;
    return {
        agent: speaker,
        title: speaker ? `${agentName(speaker)} could not answer` : 'The board’s turn failed',
        text: said || message || 'The server sent no message with this failure.',
        cause: code,
        causeText: `Server’s cause class: ${serverClassText(code)}`,
        // Both what the card says and what the server called it.
        serverMessage: said && message && !repeatsFailure(said, { text: message }) ? message : null,
    };
}
