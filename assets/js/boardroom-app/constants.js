/**
 * Boardroom app constants: storage keys, the board roster, limits, and the
 * user-facing status texts shared by the BoardroomApp collaborators.
 */

// User-selectable chat log level (persisted); a message shows when its rank
// is <= the selected rank. 'success' ranks with 'info'.
export const LOG_LEVEL_STORAGE_KEY = 'boardroom-log-level';
export const LOG_RANKS = { off: -1, error: 0, warning: 1, success: 2, info: 2, verbose: 3 };
export const LOG_LEVEL_OPTIONS = [['off', 'Off'], ['error', 'Error'], ['warning', 'Warning'], ['info', 'Info'], ['verbose', 'Verbose']];

// sessionStorage key used to stash an in-progress draft message across the
// full-tab redirect round-trip (see Option B: full-tab redirect, restore
// visual state after). Cleared once restored.
export const DRAFT_STORAGE_KEY = 'boardroom_draft_message';

// sessionStorage key recording when a backend 401 last forced a login
// redirect. If the backend still answers 401 right after a fresh sign-in,
// the token itself is being rejected (e.g. audience/scope/role mismatch),
// so redirecting again would loop forever. See MsalAuth.handleUnauthorized().
export const AUTH_REDIRECT_STORAGE_KEY = 'boardroom_auth_redirect_at';
export const AUTH_REDIRECT_COOLDOWN_MS = 5 * 60 * 1000;

// Entra's admin-consent endpoint returns to the redirect URI with
// `?admin_consent=True&tenant=<tid>` (or `error`/`error_description`).
// Consent only creates the Enterprise application in that tenant; the
// backend still answers `request_onboarding` until the operator activates
// the tenant's registry entry. localStorage key prefix, per tenant ID.
export const ADMIN_CONSENT_STORAGE_PREFIX = 'boardroom_admin_consent:';
export const ADMIN_CONSENT_PARAMS = ['admin_consent', 'tenant', 'error', 'error_description', 'error_uri', 'scope'];
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The backend (ASISaga/boardroom, POST /ag-ui) runs ONE perpetual boardroom
// per company; the Founder and C-suite speak as AG-UI steps
// (STEP_STARTED.stepName). It exposes no roster REST endpoint, so the members
// sidebar is seeded from the known board and driven by step events.
export const BOARDROOM_ROSTER = [
    { agentId: 'founder', name: 'Founder', role: 'Founder' },
    { agentId: 'ceo', name: 'CEO', role: 'Chief Executive Officer' },
    { agentId: 'cfo', name: 'CFO', role: 'Chief Financial Officer' },
    { agentId: 'coo', name: 'COO', role: 'Chief Operating Officer' },
    { agentId: 'cmo', name: 'CMO', role: 'Chief Marketing Officer' },
    { agentId: 'cto', name: 'CTO', role: 'Chief Technology Officer' },
    { agentId: 'cso', name: 'CSO', role: 'Chief Strategy Officer' },
    { agentId: 'chro', name: 'CHRO', role: 'Chief HR Officer' },
];

// Backend sanitize.MAX_USER_TEXT_CHARS
export const MAX_USER_TEXT_CHARS = 8000;

// 07 "User interjection": status shown when the user sends while a turn is
// in flight. The in-flight turn keeps streaming; the new message is its own run.
export const INTERJECTION_STATUS_USER = 'boardroom in session — your input will be raised by the chair';
export const INTERJECTION_STATUS_AUTONOMOUS =
    'the boardroom is mid-discussion on a scheduled item; your message is queued and will be addressed shortly';
// Bounded UI timeout for the interjection status (a UI tuning parameter, 07).
export const INTERJECTION_STATUS_TIMEOUT_MS = 90 * 1000;

// Shown from a turn's RUN_STARTED until its first speaker step or message,
// so a long first LLM call is not a blank screen.
export const DELIBERATING_STATUS = 'The board is deliberating…';
// Spec 03 "serve live-only" error surface: the hydrate's STATE_SNAPSHOT has
// live_only: true when the board's memory (mind) is unreachable.
export const LIVE_ONLY_BANNER = 'Live-only: board memory unavailable — history and grounding are off.';

// The backend mints the boardroom thread id (it replaces the client's
// threadId and returns the real one in RUN_STARTED.threadId); this
// placeholder is sent until the hydrate's RUN_STARTED reveals it.
export const PENDING_THREAD_ID = 'boardroom:pending';

/**
 * Speaker relay panel (purpose-agent#37, boardroom#79): one collapsible
 * section per relay field. The values hold user and company data, so they
 * are only ever set as textContent.
 */
export const RELAY_PANEL_SUMMARY = 'Mind / Prompt / Inference';
export const RELAY_SECTIONS = [['mind_context', 'Mind context'], ['prompt', 'Prompt'], ['inference', 'Inference']];

// Legacy 403 detail for a tenant with no active registry entry:
// "this organization is not registered for Boardroom (error_id <32-hex>)".
// Fallback only, for a backend that predates the structured error body
// (`code: 'tenant_not_registered'`, `error_id`).
export const UNREGISTERED_ORG_PATTERN = /not registered for Boardroom/i;
export const ERROR_ID_PATTERN = /error_id\s+([0-9a-f]{32})/i;

// `sign_in` codes a fresh token cannot fix: the token is for another API or
// authority (usually a wrong MSAL_API_SCOPES / authority), so a redirect
// would only be rejected the same way. Shown as a configuration error.
export const CONFIG_SIGN_IN_CODES = new Set(['audience_mismatch', 'issuer_mismatch']);

// Row labels for GET /auth/status `checks[].id` (role checks are `role:<name>`).
export const AUTH_CHECK_LABELS = {
    token: 'Sign-in token accepted',
    tenant_registered: 'Organization registered for Boardroom',
};

export const NOTE_SOURCES = {
    deliberating: 'Boardroom',
    interjection: 'Boardroom',
    'event-error': 'Boardroom backend',
    'unregistered-organization': 'Boardroom auth',
};

/**
 * Owner's agenda view (boardroom-orchestration spec 21; issue #73). The
 * owner's only power is a veto, inside the veto window from `decided_at`.
 * Titles, decisions and reasons are untrusted CXO text: textContent only.
 */
export const AGENDA_BUTTON_LABEL = 'Agenda';
export const AGENDA_HEADING = 'Agenda: decisions and veto';
export const AGENDA_DECISIONS_HEADING = 'Pending and recent decisions';
export const AGENDA_DIGEST_HEADING = 'Decided below the board since it last met (consent digest)';
export const AGENDA_EMPTY_DECISIONS = 'No pending or recent decisions.';
export const AGENDA_EMPTY_DIGEST = 'Nothing decided below the board is waiting to be reported.';
export const AGENDA_DISABLED = 'The agenda is not switched on for this company.';
export const AGENDA_UNAVAILABLE = 'The agenda is not available yet.';
export const AGENDA_LOADING = 'Loading the agenda…';
export const AGENDA_VETO_REASON_LABEL = 'Reason for the veto (binds the item’s next discussion)';
export const AGENDA_VETO_SUBMIT = 'Veto';
export const AGENDA_VETO_DONE = 'Vetoed: the item is back on the agenda with your reason.';
export const AGENDA_VETO_CLOSED = 'The veto window has closed; the veto was refused.';
export const AGENDA_VETO_FAILED = 'The veto could not be recorded.';
// Placeholder default (spec 21 R7 `veto_window_hours`) when the view omits it.
export const AGENDA_DEFAULT_VETO_WINDOW_HOURS = 24;
export const AGENDA_STATUS_LABELS = {
    pending: 'Pending (waiting out the veto window)',
    effective: 'Effective',
    vetoed: 'Vetoed',
    called_in: 'Called in to the board',
};
export const AGENDA_LEVEL_LABELS = { one: 'one CXO', pair: 'pair', board: 'board' };
