/**
 * Sign-in gate: GET {api}/auth/status before the boardroom starts, the
 * capabilities it grants (admin controls are `[data-boardroom-admin]`),
 * and 401/403 handling mid-session.
 */

import {
    UNREGISTERED_ORG_PATTERN,
    ERROR_ID_PATTERN,
    CONFIG_SIGN_IN_CODES,
} from './constants.js';

export class AuthGate {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.recheck = null;
        this.unregisteredNote = null;
    }

    /**
     * True when the boardroom may start: F reports `ready`, or F predates
     * /auth/status (then the hydrate's own errors decide, as before).
     * Otherwise the checklist is shown, or a sign-in redirect is under way.
     */
    async check() {
        const status = await this.fetchStatus();
        if (!status) return !this.app.msalAuth.redirecting;
        return this.applyStatus(status);
    }

    /**
     * @returns {Promise<object|null>} The /auth/status body; a status built
     *   from F's structured error (500 server_misconfigured); or null when
     *   the endpoint is unavailable (older F, network failure).
     */
    async fetchStatus() {
        if (!this.app.copilotKit || this.app.msalAuth.redirecting) return null;
        try {
            return await this.app.copilotKit.fetchAuthStatus();
        } catch (error) {
            if (this.app.msalAuth.redirecting) return null;
            if (error?.code && error?.action) {
                return {
                    ready: false,
                    code: error.code,
                    action: error.action,
                    detail: error.detail ?? null,
                    error_id: error.errorId ?? null,
                    checks: [],
                };
            }
            console.warn('[Boardroom] Sign-in checklist unavailable (GET /auth/status):', error);
            return null;
        }
    }

    /**
     * Act on a /auth/status body. `sign_in` re-runs loginRedirect through
     * the cooldown guard, except for codes a new token cannot fix.
     * @returns {Promise<boolean>} true when the boardroom may continue.
     */
    async applyStatus(status) {
        if (this.app.msalAuth.redirecting) return false;
        this.app.authStatus = status;
        this.applyCapabilities(status.capabilities);
        if (status.ready === true) {
            this.app.authChecklist.clear();
            return true;
        }
        if (status.action === 'sign_in' && !CONFIG_SIGN_IN_CODES.has(status.code)) {
            const err = new Error(status.detail || 'Sign-in required');
            err.status = 401;
            err.code = status.code;
            if (await this.app.msalAuth.handleUnauthorized(err)) return false;
        }
        this.app.authChecklist.render(status);
        return false;
    }

    /** Show admin-only controls (`[data-boardroom-admin]`) only to administrators. */
    applyCapabilities(capabilities) {
        this.app.capabilities = {
            participate: capabilities?.participate === true,
            administer: capabilities?.administer === true,
        };
        this.app.toggleAttribute('data-can-administer', this.app.capabilities.administer);
        this.app.querySelectorAll('[data-boardroom-admin]').forEach((el) => {
            el.hidden = !this.app.capabilities.administer;
        });
        if (!this.app.capabilities.administer) this.app.agendaPanel?.close();
    }

    /**
     * A 401/403 mid-session: re-fetch /auth/status and show the checklist.
     * Concurrent rejections share one re-check.
     */
    onRejected(error) {
        if (this.recheck) return this.recheck;
        this.recheck = (async () => {
            const status = await this.fetchStatus();
            if (status) {
                if (!(await this.applyStatus(status))) return;
                // Signed in and ready: the rejection is specific to this
                // request (e.g. company_mismatch, or an admin-only route).
                this.app.chatLog.errorNote(error);
                this.app.showToast(
                    error.code === 'role_missing' && error.requiredRole
                        ? `This needs the ${error.requiredRole} role – ask your organization’s Entra admin`
                        : 'You do not have permission for this boardroom action',
                    'error'
                );
                return;
            }
            if (!this.app.msalAuth.redirecting) this.handleLegacyError(error);
        })().finally(() => { this.recheck = null; });
        return this.recheck;
    }

    /** 401/403 handling when F's /auth/status is unavailable (older F). */
    handleLegacyError(error) {
        if (error.status === 401) {
            if (CONFIG_SIGN_IN_CODES.has(error.code)) {
                this.app.chatLog.errorNote(error);
                this.app.showToast('Boardroom sign-in is misconfigured – contact support', 'error');
                return;
            }
            this.app.msalAuth.handleUnauthorized(error);
            return;
        }
        if (error.code === 'tenant_not_registered'
            || (!error.code && UNREGISTERED_ORG_PATTERN.test(error.detail || ''))) {
            this.showUnregisteredOrganization(error);
            return;
        }
        this.app.chatLog.errorNote(error);
        this.app.showToast(
            error.code === 'role_missing' && error.requiredRole
                ? `Ask your organization’s Entra admin to assign you the ${error.requiredRole} role`
                : 'You do not have permission to take part in this boardroom',
            'error'
        );
    }

    /**
     * The signed-in tenant has no active Boardroom registry entry (403).
     * Shown as a persistent note so the reference can be quoted; replaced,
     * not duplicated, when a later request is rejected the same way.
     */
    showUnregisteredOrganization(error) {
        const errorId = error?.errorId || ERROR_ID_PATTERN.exec(error?.detail || '')?.[1];
        const text = 'Your organization is not set up for Boardroom yet. ' +
            (errorId
                ? `Ask your administrator to contact support, quoting reference ${errorId}.`
                : 'Ask your administrator to contact support.');
        this.unregisteredNote?.remove();
        this.unregisteredNote = this.app.chatLog.note('unregistered-organization', text);
        this.app.showToast('Your organization is not set up for Boardroom yet', 'error');
    }
}

export default AuthGate;
