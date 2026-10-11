/**
 * The Boardroom sign-in checklist that replaces the chat when GET
 * {api}/auth/status is not `ready`, and Entra's admin-consent return.
 * Built with DOM APIs (textContent only).
 */

import { MSAL_CONFIG } from './msal-auth.js';
import {
    ADMIN_CONSENT_STORAGE_PREFIX,
    ADMIN_CONSENT_PARAMS,
    GUID_PATTERN,
    CONFIG_SIGN_IN_CODES,
    AUTH_CHECK_LABELS,
} from './constants.js';

export class AuthChecklist {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.consentReturn = null;
        this.panel = null;
        this.blocked = false;
    }

    el(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    button(label, onClick) {
        const btn = this.el('button', 'boardroom-auth-checklist__btn', label);
        btn.type = 'button';
        btn.addEventListener('click', onClick);
        return btn;
    }

    async copyText(text, what) {
        try {
            await navigator.clipboard.writeText(text);
            this.app.showToast(`${what} copied`, 'success');
        } catch (err) {
            console.warn('[Boardroom] Copy failed:', err);
            this.app.showToast(`Could not copy ${what.toLowerCase()}`, 'error');
        }
    }

    checkLabel(id) {
        const key = String(id || '');
        if (key in AUTH_CHECK_LABELS) return AUTH_CHECK_LABELS[key];
        if (key.startsWith('role:')) return `Role "${key.slice(5)}" assigned`;
        return key;
    }

    /** The App Role the user must be given (from the failing role check). */
    requiredRole(status) {
        const failed = (status.checks || []).find((c) => c?.ok === false && c.required_role
            && (!status.code || c.code === status.code));
        return failed?.required_role || status.required_role || status.required_roles?.participate || 'participant';
    }

    /** Admin-consent link, only when it is an https Entra URL. */
    safeConsentUrl(url) {
        try {
            const parsed = new URL(String(url));
            return parsed.protocol === 'https:' && parsed.hostname === 'login.microsoftonline.com' ? parsed.href : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Read Entra's admin-consent response (`?admin_consent=True&tenant=…`,
     * or `?error=…&error_description=…`) from the URL, remember a grant per
     * tenant, and strip those parameters. An MSAL response (it carries
     * `state`/`code`) is left alone for handleRedirectPromise().
     */
    handleAdminConsentReturn() {
        let url;
        try {
            url = new URL(window.location.href);
        } catch (_) {
            return;
        }
        const q = url.searchParams;
        const isConsentResponse = q.has('admin_consent')
            || (q.has('error') && !q.has('state') && !q.has('code'));
        if (!isConsentResponse) return;

        const tenant = String(q.get('tenant') || '').toLowerCase();
        const granted = String(q.get('admin_consent') || '').toLowerCase() === 'true' && !q.has('error');
        this.consentReturn = {
            granted,
            at: new Date().toISOString(),
            tenant: GUID_PATTERN.test(tenant) ? tenant : null,
            error: granted ? null : String(q.get('error') || 'consent_not_granted').slice(0, 100),
            errorDescription: granted ? null : String(q.get('error_description') || '').slice(0, 500),
        };
        if (granted && this.consentReturn.tenant) {
            try {
                localStorage.setItem(ADMIN_CONSENT_STORAGE_PREFIX + this.consentReturn.tenant,
                    this.consentReturn.at);
            } catch (_) { /* storage unavailable */ }
        }

        ADMIN_CONSENT_PARAMS.forEach((name) => q.delete(name));
        try {
            window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
        } catch (_) { /* ignore */ }

        if (granted) {
            this.app.showToast('Admin consent granted. Boardroom support must now activate your organization.', 'success');
        } else {
            this.app.showToast('Admin consent was not granted', 'error');
        }
    }

    /** ISO time admin consent was granted for `tenantId` from this browser, or null. */
    adminConsentGrantedAt(tenantId) {
        const tenant = String(tenantId || '').toLowerCase();
        if (!GUID_PATTERN.test(tenant)) return null;
        if (this.consentReturn?.granted && this.consentReturn.tenant === tenant) {
            return this.consentReturn.at;
        }
        try {
            return localStorage.getItem(ADMIN_CONSENT_STORAGE_PREFIX + tenant);
        } catch (_) {
            return null;
        }
    }

    /** Per-`action` guidance naming who has to act, plus its buttons. */
    guidance(status) {
        const nodes = [];
        const buttons = [];
        const tenant = status.tenant_id || 'unknown';
        const reference = status.error_id ? ` (reference ${status.error_id})` : '';
        const appClientId = status.onboarding?.app_client_id || MSAL_CONFIG.auth.clientId;
        const p = (text) => nodes.push(this.el('p', 'boardroom-auth-checklist__guidance', text));

        switch (status.action) {
            case 'request_onboarding': {
                // Admin consent (Entra) and activation (Boardroom's registry)
                // are separate steps: consent alone never makes this `ready`.
                const consentedAt = this.adminConsentGrantedAt(status.tenant_id);
                const consentReturn = this.consentReturn;
                if (consentReturn && !consentReturn.granted) {
                    p(`Admin consent was not granted (${consentReturn.error})` +
                        (consentReturn.errorDescription ? `: ${consentReturn.errorDescription}` : '.'));
                }
                if (consentedAt) {
                    const when = new Date(consentedAt);
                    p(`Admin consent for Boardroom was granted for tenant ${tenant}` +
                        (Number.isNaN(when.getTime()) ? '' : ` (${when.toLocaleString()})`) + '. That step is done.');
                    p(`Remaining step: Boardroom support must register and activate your organization ` +
                        `(tenant ${tenant}). Ask Boardroom support to activate it` +
                        (status.error_id ? `, quoting reference ${status.error_id}` : '') +
                        ', then select Check again.');
                } else {
                    p(`Your organization (tenant ${tenant}) is not set up for Boardroom. ` +
                        `Ask Boardroom support to onboard it, quoting tenant ${tenant}` +
                        (status.error_id ? ` and reference ${status.error_id}.` : '.'));
                }
                const consentUrl = this.safeConsentUrl(status.onboarding?.admin_consent_url);
                if (consentUrl) {
                    const para = this.el('p', 'boardroom-auth-checklist__guidance', consentedAt
                        ? 'Consent does not need to be granted again. To repeat it anyway: '
                        : 'Your organization’s Entra admin grants consent for Boardroom here ' +
                          '(this does not activate Boardroom; Boardroom support does that): ');
                    const link = this.el('a', null, consentedAt ? 'Grant admin consent again' : 'Grant admin consent');
                    link.href = consentUrl;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    para.appendChild(link);
                    nodes.push(para);
                }
                p(`Boardroom Enterprise application (client ID): ${appClientId}`);
                buttons.push(this.button('Check again', () => this.app.aguiSession.start()));
                break;
            }
            case 'request_role':
                p(`Ask your organization’s Entra admin to assign you the “${this.requiredRole(status)}” ` +
                    `role on the Boardroom Enterprise application (client ID ${appClientId}). ` +
                    'Roles appear only in a newly issued token, so sign out and sign in again afterwards.');
                buttons.push(this.button('Sign out and sign in again', () => this.app.msalAuth.signOutAndIn()));
                break;
            case 'sign_in':
                if (CONFIG_SIGN_IN_CODES.has(status.code)) {
                    p(`Boardroom sign-in is misconfigured (${status.code}): the token is issued for a different ` +
                        `API or authority, so signing in again will not help. Contact Boardroom support${reference}.`);
                } else {
                    p(`Your sign-in was not accepted${status.code ? ` (${status.code})` : ''}. Please sign in again.`);
                    buttons.push(this.button('Sign in again', () => {
                        this.app.msalAuth.clearRedirectGuard();
                        this.app.msalAuth.redirectToLogin();
                    }));
                }
                break;
            case 'retry':
                p(`Boardroom is temporarily unavailable: ${status.detail || status.code || 'please retry'}${reference}.`);
                buttons.push(this.button('Retry', () => this.app.aguiSession.start()));
                break;
            case 'contact_support':
                p(`Boardroom could not complete sign-in: ${status.detail || status.code || 'unknown error'}. ` +
                    `Contact Boardroom support${reference}.`);
                break;
            default:
                if (status.detail) p(`${status.detail}${reference}`);
        }
        return { nodes, buttons };
    }

    /**
     * Replace the chat with F's sign-in checklist: who is signed in, one row
     * per check, and what to do next. Built with DOM APIs (textContent only).
     */
    render(status) {
        this.clear();
        this.blocked = true;

        const panel = this.el('section', 'boardroom-auth-checklist');
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'boardroomAuthChecklistTitle');
        const title = this.el('h2', 'boardroom-auth-checklist__title', 'Boardroom sign-in checklist');
        title.id = 'boardroomAuthChecklistTitle';
        panel.appendChild(title);

        const user = status.user;
        if (user && (user.name || user.username)) {
            const who = user.name && user.username ? `${user.name} (${user.username})` : (user.name || user.username);
            panel.appendChild(this.el('p', 'boardroom-auth-checklist__identity', `Signed in as ${who}`));
        }
        if (status.tenant_id) {
            const tenant = this.el('p', 'boardroom-auth-checklist__tenant', 'Organization (tenant) ID: ');
            tenant.appendChild(this.el('code', null, status.tenant_id));
            tenant.appendChild(document.createTextNode(' '));
            tenant.appendChild(this.button('Copy tenant ID', () => this.copyText(status.tenant_id, 'Tenant ID')));
            panel.appendChild(tenant);
        }

        const checks = Array.isArray(status.checks) ? status.checks : [];
        if (checks.length) {
            const list = this.el('ul', 'boardroom-auth-checklist__checks');
            for (const check of checks) {
                const state = check?.ok === true ? 'ok' : check?.ok === false ? 'failed' : 'unchecked';
                const item = this.el('li', `boardroom-auth-checklist__check boardroom-auth-checklist__check--${state}`);
                item.dataset.check = String(check?.id ?? '');
                item.dataset.state = state;
                const mark = state === 'ok' ? '✓' : state === 'failed' ? '✗' : '–';
                const markEl = this.el('span', 'boardroom-auth-checklist__mark', mark);
                markEl.setAttribute('aria-hidden', 'true');
                item.appendChild(markEl);
                const stateText = state === 'ok' ? 'passed' : state === 'failed' ? 'failed' : 'not checked';
                item.appendChild(document.createTextNode(` ${this.checkLabel(check?.id)} — ${stateText}`));
                if (state === 'failed' && check.detail) {
                    item.appendChild(this.el('span', 'boardroom-auth-checklist__detail', `: ${check.detail}`));
                }
                list.appendChild(item);
            }
            panel.appendChild(list);
        }

        const { nodes, buttons } = this.guidance(status);
        nodes.forEach((n) => panel.appendChild(n));

        const actions = this.el('div', 'boardroom-auth-checklist__actions');
        buttons.forEach((b) => actions.appendChild(b));
        // The status body carries no token: safe to hand to support as-is.
        actions.appendChild(this.button('Copy diagnostics',
            () => this.copyText(JSON.stringify(status, null, 2), 'Diagnostics')));
        panel.appendChild(actions);

        const messagesEl = this.app.elements?.messagesContainer;
        if (messagesEl?.parentNode) {
            messagesEl.parentNode.insertBefore(panel, messagesEl);
            messagesEl.hidden = true;
        } else {
            this.app.appendChild(panel);
        }
        const inputEl = this.app.querySelector('.chatroom-input');
        if (inputEl) inputEl.hidden = true;
        this.panel = panel;
        this.app.hideLoading();
    }

    clear() {
        this.blocked = false;
        if (!this.panel) return;
        this.panel.remove();
        this.panel = null;
        if (this.app.elements?.messagesContainer) this.app.elements.messagesContainer.hidden = false;
        const inputEl = this.app.querySelector('.chatroom-input');
        if (inputEl) inputEl.hidden = false;
    }
}

export default AuthChecklist;
