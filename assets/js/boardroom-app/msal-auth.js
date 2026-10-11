/**
 * Microsoft Entra ID sign-in for the Boardroom app, via MSAL.js
 * (@azure/msal-browser, loaded as a CDN UMD global — see
 * _includes/msal-library.html) with a full-tab loginRedirect() flow.
 *
 * Any in-progress draft message is preserved across the redirect
 * round-trip via sessionStorage. Access tokens are attached as an
 * Authorization header by authedFetch(), which tries silent renewal first
 * and falls back to a fresh interactive redirect only when needed. MSAL
 * log entries queue until the chat log can show them.
 */

import {
    DRAFT_STORAGE_KEY,
    AUTH_REDIRECT_STORAGE_KEY,
    AUTH_REDIRECT_COOLDOWN_MS,
} from './constants.js';

// ============================================================================
// MSAL / Entra configuration
// ============================================================================
// PLACEHOLDER VALUES — replace all three before deploying. See Azure Portal →
// Microsoft Entra ID → App registrations → (this app) → Overview (for
// clientId / tenantId) and → Authentication (for the registered redirect
// URI, which must match exactly).
//
// apiScope is the scope requested when acquiring a token for the backend
// API specifically (as opposed to a login-only ID token) — typically
// "api://<backend-app-client-id>/<scope-name>", e.g.
// "api://00000000-0000-0000-0000-000000000000/access_as_user". Confirm the
// exact value with whoever owns the backend's app registration ("Expose an
// API" blade) — using the wrong scope produces a token the backend will
// reject even though login itself succeeds.

// MSAL log messages are forwarded to the boardroom chat. MSAL starts logging
// before the chat DOM exists, so entries queue until a sink is attached.
const MSAL_LOG_LEVELS = { 0: 'error', 1: 'warning', 2: 'info', 3: 'verbose', 4: 'verbose' };
const msalLogQueue = [];
let msalLogSink = null;
function msalLoggerCallback(level, message, containsPii) {
    if (containsPii || !message) return;
    const entry = { level: MSAL_LOG_LEVELS[level] || 'info', text: String(message) };
    if (msalLogSink) msalLogSink(entry); else msalLogQueue.push(entry);
}

export const MSAL_CONFIG = {
    auth: {
        clientId: '09ee9579-46c7-4163-949c-f5f90067a70c',
        // Multi-tenant: any work or school tenant may sign in; the backend
        // decides (by the token's `tid`) whether the organization is registered.
        authority: 'https://login.microsoftonline.com/organizations',
        redirectUri: 'https://boardroom.asisaga.com/boardroom/'
    },
    cache: {
        // localStorage (not the MSAL default sessionStorage) so the session
        // survives the full-tab redirect round-trip and persists across
        // browser tabs/restarts, consistent with how boardroom previously
        // persisted its auth token.
        cacheLocation: 'localStorage',
    },
    system: {
        loggerOptions: {
            loggerCallback: msalLoggerCallback,
            piiLoggingEnabled: false,
            logLevel: 3, // Verbose; the chat filters by the user-selected level
        },
    },
};

export const MSAL_API_SCOPES = ['api://09ee9579-46c7-4163-949c-f5f90067a70c/access_as_user']; // e.g. 'api://<backend-client-id>/access_as_user'

export class MsalAuth {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.client = null;
        this.account = null;
        this.redirecting = false;
    }

    /**
     * Construct the MSAL client and process any pending redirect response
     * (i.e. the user has just been sent back here after loginRedirect()).
     * Must be called and awaited before any other MSAL API is used — MSAL
     * requires handleRedirectPromise() to resolve first, even if there is
     * no redirect in progress (it resolves to null in that case).
     *
     * Restores any draft message text that was stashed in sessionStorage
     * before the redirect (see redirectToLogin()).
     */
    async init() {
        if (typeof msal === 'undefined') {
            console.error('[Boardroom] MSAL library not loaded — check that msal-library.html is included before this module.');
            return;
        }

        msalLogSink = (entry) => this.app.chatLog.showMsalLog(entry);
        this.client = new msal.PublicClientApplication(MSAL_CONFIG);
        await this.client.initialize();

        let redirectResult = null;
        try {
            redirectResult = await this.client.handleRedirectPromise();
        } catch (err) {
            console.error('[Boardroom] MSAL redirect handling failed:', err);
        }

        if (redirectResult?.account) {
            this.account = redirectResult.account;
        } else {
            // Not returning from a redirect — check for an existing cached
            // session (e.g. a previous tab already signed in).
            const accounts = this.client.getAllAccounts();
            if (accounts.length > 0) {
                this.account = accounts[0];
            }
        }

        this.restoreDraftMessage();
        this.flushLogs();
    }

    flushLogs() {
        while (msalLogQueue.length && this.app.elements?.messagesContainer) {
            this.app.chatLog.showMsalLog(msalLogQueue.shift());
        }
    }

    isAuthenticated() {
        return !!this.account;
    }

    /**
     * Save the current input field's draft text to sessionStorage, then
     * navigate the full tab to Entra's login page via loginRedirect(). The
     * page fully reloads on return; init() (called again on that
     * fresh load) picks up the redirect result and restoreDraftMessage()
     * puts the draft text back.
     * @returns {Promise<never>} Never resolves — the page navigates away.
     */
    async redirectToLogin() {
        try {
            const draft = this.app.elements?.inputField?.value;
            if (draft) sessionStorage.setItem(DRAFT_STORAGE_KEY, draft);
        } catch (err) {
            console.warn('[Boardroom] Could not persist draft message before redirect:', err);
        }

        this.redirecting = true;
        await this.client.loginRedirect({ scopes: MSAL_API_SCOPES });
        // loginRedirect() navigates away; execution does not continue past
        // this point on success.
    }

    /**
     * Restore a draft message stashed before a login redirect, if any.
     * Called once from init(), after the static input field exists
     * (hydration has already run by the time connectedCallback calls this).
     */
    restoreDraftMessage() {
        let draft = null;
        try {
            draft = sessionStorage.getItem(DRAFT_STORAGE_KEY);
            if (draft) sessionStorage.removeItem(DRAFT_STORAGE_KEY);
        } catch (err) {
            console.warn('[Boardroom] Could not read persisted draft message:', err);
            return;
        }
        if (draft && this.app.elements?.inputField) {
            this.app.elements.inputField.value = draft;
        }
    }

    /**
     * Acquire an access token for the backend API, silently if possible.
     * Falls back to a full-tab redirect (redirectToLogin) when silent
     * acquisition fails — e.g. no cached session, or the session has
     * expired and needs fresh interactive sign-in.
     * @returns {Promise<string|null>} The access token, or null if a
     *   redirect was triggered (in which case the page is navigating away).
     */
    async acquireToken() {
        if (!this.account) {
            await this.redirectToLogin();
            return null;
        }

        try {
            const result = await this.client.acquireTokenSilent({
                scopes: MSAL_API_SCOPES,
                account: this.account,
            });
            return result.accessToken;
        } catch (err) {
            // InteractionRequiredAuthError and similar — silent acquisition
            // failed, fall back to interactive redirect.
            console.warn('[Boardroom] Silent token acquisition failed, redirecting to login:', err);
            await this.redirectToLogin();
            return null;
        }
    }

    async authedFetch(url, options = {}) {
        const token = await this.acquireToken();
        if (!token) {
            // acquireToken() triggered a redirect; the page is navigating
            // away, so this request will never complete. Return a
            // never-resolving promise-like rejection is unnecessary since
            // the page unload will abort everything shortly — just reject
            // cleanly for any caller that might race the navigation.
            throw new Error('Redirecting to login — request aborted.');
        }

        const doFetch = (accessToken) => fetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                Authorization: `Bearer ${accessToken}`,
            },
        });

        let response = await doFetch(token);

        if (response.status === 401) {
            // Token was rejected despite MSAL considering it valid (e.g.
            // revoked server-side) — force a fresh interactive login rather
            // than retrying with the same stale token, unless we only just
            // came back from one (which would loop).
            const err = new Error(`Request rejected by backend (401): ${url}`);
            err.status = 401;
            if (await this.handleUnauthorized(err)) {
                throw new Error('Redirecting to login — request aborted.');
            }
            throw err;
        }

        this.clearRedirectGuard();
        return response;
    }

    /**
     * Handle a backend 401. Redirects to Entra sign-in at most once per
     * AUTH_REDIRECT_COOLDOWN_MS: if the backend still rejects the token
     * right after a fresh sign-in, re-authenticating cannot help and would
     * reload the page in an endless loop, so surface an error instead.
     * @returns {Promise<boolean>} true if a login redirect was triggered.
     */
    async handleUnauthorized(error) {
        let lastRedirect = 0;
        try {
            lastRedirect = Number(sessionStorage.getItem(AUTH_REDIRECT_STORAGE_KEY)) || 0;
        } catch (_) { /* storage unavailable — fall through */ }

        if (Date.now() - lastRedirect < AUTH_REDIRECT_COOLDOWN_MS) {
            console.error(
                '[Boardroom] Backend rejected the access token immediately after sign-in; ' +
                'not redirecting again to avoid a login loop. Check the API scope / audience ' +
                'and App Role configuration.', error
            );
            this.app.showToast('Signed in, but the boardroom service rejected your credentials', 'error');
            return false;
        }

        try {
            sessionStorage.setItem(AUTH_REDIRECT_STORAGE_KEY, String(Date.now()));
        } catch (_) { /* best effort */ }
        this.account = null;
        await this.redirectToLogin();
        return true;
    }

    clearRedirectGuard() {
        try {
            sessionStorage.removeItem(AUTH_REDIRECT_STORAGE_KEY);
        } catch (_) { /* best effort */ }
    }

    /** Roles appear only in newly issued tokens: sign out, then sign in again. */
    async signOutAndIn() {
        this.clearRedirectGuard();
        this.redirecting = true;
        try {
            await this.client.logoutRedirect({
                account: this.account,
                postLogoutRedirectUri: MSAL_CONFIG.auth.redirectUri,
            });
        } catch (err) {
            this.redirecting = false;
            console.error('[Boardroom] Sign-out failed:', err);
            this.app.showToast('Sign-out failed – please try again', 'error');
        }
    }
}

export default MsalAuth;
