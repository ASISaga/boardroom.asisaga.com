/**
 * Who is in the room (visible board, follow-up 3; issue #78), DOM-free.
 * The page lists only the members the server reports, in the hydrate
 * snapshot's `room` (proposed to the Function App, boardroom#84):
 *
 *   room: [{"agent_id": "cfo", "name": "CFO", "role": "Chief Financial Officer"}, ...]
 *   or    {"members": [...]}      (a member may also be a bare role id)
 *
 * "Online" means in the current round. When the server does not report the
 * room, nothing is listed and nothing is counted: the panel says "not
 * reported". There is no static list.
 */

import { BOARDROOM_ROSTER } from './constants.js';

const ID_PATTERN = /^[a-z0-9._-]{1,40}$/;
const KNOWN = new Map(BOARDROOM_ROSTER.map((a) => [a.agentId, a]));

export const ROOM_NOT_REPORTED = 'Not reported';
export const ROOM_NOT_REPORTED_DETAIL = 'The server did not report who is in the room.';

function member(raw) {
    const obj = raw && typeof raw === 'object' ? raw : { agent_id: raw };
    const id = String(obj.agent_id ?? obj.id ?? '').toLowerCase().replace(/^boardroom-/, '');
    if (!ID_PATTERN.test(id)) return null;
    const known = KNOWN.get(id);
    const name = typeof obj.name === 'string' && obj.name ? obj.name.slice(0, 60) : (known?.name || id.toUpperCase());
    const role = typeof obj.role === 'string' && obj.role ? obj.role.slice(0, 80) : (known?.role || '');
    return { agentId: id, name, role, online: obj.online !== false };
}

/**
 * The room the server reported, or null when it did not.
 * @returns {{members: {agentId: string, name: string, role: string, online: boolean}[]}|null}
 */
export function roomReport(state) {
    if (!state || typeof state !== 'object' || !('room' in state)) return null;
    const room = state.room;
    const list = Array.isArray(room) ? room : (room && Array.isArray(room.members) ? room.members : null);
    if (!list) return null;
    const seen = new Set();
    const members = [];
    for (const raw of list) {
        const m = member(raw);
        if (m && !seen.has(m.agentId)) {
            seen.add(m.agentId);
            members.push(m);
        }
    }
    return { members };
}

/** The panel's count: `3 online`, `0 online`, or `not reported`. Never a guess. */
export function roomCountText(report) {
    if (!report) return 'not reported';
    return `${report.members.filter((m) => m.online).length} online`;
}
