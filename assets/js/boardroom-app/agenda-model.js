/**
 * The owner's agenda view as data (boardroom-orchestration spec 21): the
 * F response normalised, each decision's status and veto window, and the
 * consent digest lines. No DOM, no clock: `now` is passed in.
 *
 * Every string here is untrusted CXO text (titles, decisions, reasons). It
 * is only ever coerced to a string; the panel sets it as textContent.
 */

import {
    AGENDA_DEFAULT_VETO_WINDOW_HOURS,
    AGENDA_LEVEL_LABELS,
    MAX_USER_TEXT_CHARS,
} from './constants.js';

export const AGENDA_STATUSES = ['pending', 'effective', 'vetoed', 'called_in'];
export const ITEM_HANDLE_PATTERN = /^item\.\d+$/;
const HOUR_MS = 60 * 60 * 1000;

function text(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function time(value) {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function reversal(value) {
    if (!value || typeof value !== 'object') return null;
    return { by: text(value.by), at: text(value.at), reason: text(value.reason) };
}

/**
 * One decision record (spec 21 R21) with its item's handle and title.
 * @returns {object|null} null when it has no valid item handle.
 */
export function normalizeDecision(raw, nowMs = null) {
    if (!raw || typeof raw !== 'object') return null;
    const item = text(raw.item);
    if (!ITEM_HANDLE_PATTERN.test(item)) return null;
    const decision = {
        item,
        title: text(raw.title),
        text: text(raw.text),
        reason: text(raw.reason),
        forecast: text(raw.forecast),
        level: text(raw.level),
        deciders: Array.isArray(raw.deciders) ? raw.deciders.map(text).filter(Boolean) : [],
        decidedAt: text(raw.decided_at),
        effectiveAt: text(raw.effective_at),
        vetoWindowEndsAt: text(raw.veto_window_ends_at),
        vetoed: reversal(raw.vetoed),
        calledIn: reversal(raw.called_in),
        status: AGENDA_STATUSES.includes(raw.status) ? raw.status : null,
    };
    if (!decision.status) decision.status = deriveStatus(decision, nowMs);
    return decision;
}

/** Spec 21 R22, for a view that omits `status`. */
export function deriveStatus(decision, nowMs) {
    if (decision.vetoed) return 'vetoed';
    if (decision.calledIn) return 'called_in';
    const effective = time(decision.effectiveAt);
    if (effective !== null && nowMs !== null && nowMs < effective) return 'pending';
    return 'effective';
}

/**
 * The F body of GET {api}/agenda, normalised. Malformed entries are dropped.
 * @param {object} body
 * @returns {{enabled: boolean, now: number|null, vetoWindowHours: number,
 *   decisions: object[], digest: {decisions: object[], more: number}}}
 */
export function normalizeAgendaView(body) {
    const view = body && typeof body === 'object' ? body : {};
    const now = time(view.now);
    const hours = Number(view.veto_window_hours);
    const digest = view.consent_digest && typeof view.consent_digest === 'object' ? view.consent_digest : {};
    const decisions = (list) => (Array.isArray(list) ? list : [])
        .map((d) => normalizeDecision(d, now))
        .filter(Boolean);
    const more = Number(digest.more);
    return {
        enabled: view.enabled !== false,
        now,
        vetoWindowHours: Number.isFinite(hours) && hours >= 0 ? hours : AGENDA_DEFAULT_VETO_WINDOW_HOURS,
        decisions: decisions(view.decisions),
        digest: {
            decisions: decisions(digest.decisions),
            more: Number.isInteger(more) && more > 0 ? more : 0,
        },
    };
}

/** When the decision's veto window closes (ms), or null when unknown. */
export function vetoWindowEndsAt(decision, vetoWindowHours = AGENDA_DEFAULT_VETO_WINDOW_HOURS) {
    const ends = time(decision.vetoWindowEndsAt);
    if (ends !== null) return ends;
    const decided = time(decision.decidedAt);
    return decided === null ? null : decided + vetoWindowHours * HOUR_MS;
}

/** Milliseconds of veto window left at `nowMs` (0 when closed or unknown). */
export function vetoWindowLeftMs(decision, nowMs, vetoWindowHours) {
    const ends = vetoWindowEndsAt(decision, vetoWindowHours);
    if (ends === null || !Number.isFinite(nowMs)) return 0;
    return Math.max(0, ends - nowMs);
}

/**
 * Whether the owner may veto it now: not already vetoed or called in, and
 * inside the window. O decides; this only hides a veto it would refuse.
 */
export function canVeto(decision, nowMs, vetoWindowHours) {
    if (decision.status !== 'pending' && decision.status !== 'effective') return false;
    return vetoWindowLeftMs(decision, nowMs, vetoWindowHours) > 0;
}

/** "23 h 5 min left", "4 min left", "under 1 min left" or "closed"; rounded down. */
export function formatWindowLeft(ms) {
    if (!(ms > 0)) return 'closed';
    const minutes = Math.floor(ms / 60000);
    if (!minutes) return 'under 1 min left';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min left`;
    return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

/** Spec 21 R19 digest line: "[item.N] <title>: <decision> (<DECIDERS>, one CXO|pair)". */
export function digestLine(decision) {
    const level = AGENDA_LEVEL_LABELS[decision.level] || decision.level;
    const who = [decision.deciders.join(', '), level].filter(Boolean).join(', ');
    return `[${decision.item}] ${decision.title}: ${decision.text}${who ? ` (${who})` : ''}`;
}

/** Spec 21 R19 overflow line, or '' when nothing more. */
export function digestMoreLine(more) {
    return more > 0 ? `… and ${more} more not shown.` : '';
}

/**
 * The trimmed veto reason, or null when it is empty or too long. A reason is
 * required (spec 21 R24).
 */
export function vetoReason(value) {
    const reason = text(value).trim();
    if (!reason || reason.length > MAX_USER_TEXT_CHARS) return null;
    return reason;
}
