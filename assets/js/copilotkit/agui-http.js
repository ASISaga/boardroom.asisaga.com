/**
 * HTTP helpers for the Boardroom AG-UI client: run/thread ids, the sign-in
 * checklist URL, request headers and the structured error of a non-2xx
 * response.
 */

export class AgUiHttp {
  static randomUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /** `{api}/auth/status`, a sibling of the runtime's `/ag-ui` path. */
  static authStatusUrlFor(runtimeUrl) {
    return String(runtimeUrl || '/ag-ui').replace(/\/[^/]*\/?$/, '/auth/status');
  }

  /** `{api}/agenda`, the owner's agenda view, a sibling of the runtime's `/ag-ui` path. */
  static agendaUrlFor(runtimeUrl) {
    return String(runtimeUrl || '/ag-ui').replace(/\/[^/]*\/?$/, '/agenda');
  }

  /**
   * Request headers for an AG-UI POST: SSE accept, the caller's extra
   * headers, and a Bearer token from `getAccessToken` (called fresh for
   * every request, so the caller owns acquisition/refresh, e.g. MSAL
   * silent renewal). A failing `getAccessToken` sends no Authorization.
   */
  static async buildHeaders({ extraHeaders = {}, getAccessToken = null } = {}, extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...extraHeaders,
      ...extra,
    };
    if (getAccessToken) {
      try {
        const token = await getAccessToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch (err) {
        console.error('[CopilotKit] getAccessToken() failed:', err);
      }
    }
    return headers;
  }

  /**
   * Error for a non-2xx response: `status`, plus the backend's structured
   * error body when it is JSON: `detail`, `code` (e.g. 'tenant_not_registered'),
   * `action` (sign_in | request_onboarding | request_role | contact_support |
   * retry | none), `errorId`, `requiredRole` and `errorType` (the body's
   * `error`). A 401's RFC 6750 challenge is kept as `wwwAuthenticate`.
   */
  static async httpError(response, prefix) {
    const errText = await response.text().catch(() => response.statusText);
    const err = new Error(`${prefix} ${response.status}: ${errText}`);
    err.status = response.status;
    const challenge = response.headers?.get?.('WWW-Authenticate');
    if (challenge) err.wwwAuthenticate = challenge;
    try {
      const body = JSON.parse(errText);
      if (body && typeof body === 'object') {
        if (typeof body.detail === 'string') err.detail = body.detail;
        if (typeof body.code === 'string') err.code = body.code;
        if (typeof body.action === 'string') err.action = body.action;
        if (typeof body.error_id === 'string') err.errorId = body.error_id;
        if (typeof body.required_role === 'string') err.requiredRole = body.required_role;
        if (typeof body.error === 'string') err.errorType = body.error;
        err.body = body;
      }
    } catch (_) { /* not JSON */ }
    return err;
  }
}

export default AgUiHttp;
