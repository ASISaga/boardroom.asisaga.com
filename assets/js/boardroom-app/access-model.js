/**
 * The access the server applied (visible board, follow-up 3; issue #78),
 * DOM-free. The hydrate snapshot's `state.access` (proposed to the Function
 * App, boardroom#84):
 *
 *   access: {"roles": ["Boardroom.Owner", ...], "audience": "owner"|"operator",
 *            "token": "ok"|"stale", "detail": "<operator-only text>"}
 *
 * (`token_stale: true` is read as `token: "stale"`.) An owner is told only
 * which view they are in; an operator also sees the roles by name and the
 * audience. A token the server says looks out of date asks for a new
 * sign-in. A missing report is "not reported", never an error.
 */

const AUDIENCES = ['owner', 'operator'];

export const SIGN_IN_AGAIN_LABEL = 'Sign in again';

/** The access report, normalised, or null when the server sent none. */
export function accessReport(state) {
    const a = state && typeof state === 'object' ? state.access : null;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const roles = Array.isArray(a.roles)
        ? a.roles.filter((r) => typeof r === 'string' && r).map((r) => r.slice(0, 80)).slice(0, 40)
        : null;
    const audience = AUDIENCES.includes(a.audience) ? a.audience : null;
    const stale = a.token === 'stale' || a.token_stale === true;
    return {
        roles,
        audience,
        stale,
        detail: typeof a.detail === 'string' && a.detail ? a.detail.slice(0, 480) : null,
    };
}

/**
 * What to show.
 * @returns {{text: string, operatorText: string, stale: boolean, staleText: string}}
 *   `text` is for everyone; `operatorText` only for an operator session.
 */
export function accessView(report, { operator = false } = {}) {
    if (!report) {
        return { text: 'Access: not reported by the server.', operatorText: '', stale: false, staleText: '' };
    }
    const operatorView = operator === true || report.audience === 'operator';
    const text = report.audience === 'operator'
        ? 'You are in the operator view.'
        : (report.audience === 'owner' ? 'You are in the owner view.' : 'Which view you are in: not reported.');
    const roles = report.roles
        ? (report.roles.length ? report.roles.join(', ') : 'none')
        : 'not reported';
    const operatorText = operatorView
        ? `Access applied by the server: roles ${roles}; audience ${report.audience || 'not reported'}.`
        : '';
    return {
        text,
        operatorText,
        stale: report.stale,
        staleText: report.stale
            ? 'Your sign-in looks out of date: the server could not match it to your current roles. Sign in again to refresh it.'
            : '',
    };
}
