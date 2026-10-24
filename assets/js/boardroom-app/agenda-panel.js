/**
 * The owner's view of the Boardroom agenda (boardroom-orchestration spec 21,
 * issue #73): pending and recent decisions with their level, deciders,
 * times, status and veto window left; the consent digest; and a veto with a
 * reason. Opened from the admin-only "Agenda" header button.
 *
 * Data comes from F (GET {api}/agenda, POST {api}/agenda/veto) through
 * CopilotKitClient. Titles, decisions and reasons are untrusted CXO text:
 * they are only ever set as textContent, never parsed as HTML. O is the
 * authority on the veto window; the panel only hides a veto O would refuse.
 */

import {
    AGENDA_HEADING,
    AGENDA_DECISIONS_HEADING,
    AGENDA_DIGEST_HEADING,
    AGENDA_EMPTY_DECISIONS,
    AGENDA_EMPTY_DIGEST,
    AGENDA_DISABLED,
    AGENDA_UNAVAILABLE,
    AGENDA_LOADING,
    AGENDA_VETO_REASON_LABEL,
    AGENDA_VETO_SUBMIT,
    AGENDA_VETO_DONE,
    AGENDA_VETO_CLOSED,
    AGENDA_VETO_FAILED,
    AGENDA_STATUS_LABELS,
    AGENDA_LEVEL_LABELS,
    MAX_USER_TEXT_CHARS,
} from './constants.js';
import {
    normalizeAgendaView,
    vetoWindowLeftMs,
    canVeto,
    formatWindowLeft,
    digestLine,
    digestMoreLine,
    vetoReason,
} from './agenda-model.js';

// Refresh the windows left while the panel is open (in place, so a veto
// reason being typed is kept).
const TICK_MS = 60 * 1000;

function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = textValue;
    return node;
}

function formatTime(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : (value || '—');
}

export class AgendaPanel {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.root = null;
        this.view = null;
        this.clockOffset = 0;
        this.timer = null;
        this.loading = null;
    }

    get isOpen() {
        return !!this.root && !this.root.hidden;
    }

    /** The server's clock, so the window left does not depend on the browser's. */
    now() {
        return Date.now() + this.clockOffset;
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    async open() {
        if (!this.app.capabilities?.administer) return;
        this.ensureRoot();
        this.root.hidden = false;
        this.app.querySelector('[data-boardroom-agenda-toggle]')?.setAttribute('aria-expanded', 'true');
        if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
        await this.load();
    }

    close() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.root) this.root.hidden = true;
        this.app.querySelector('[data-boardroom-agenda-toggle]')?.setAttribute('aria-expanded', 'false');
    }

    ensureRoot() {
        if (this.root) return;
        const root = el('section', 'boardroom-agenda');
        root.id = 'boardroom-agenda';
        root.hidden = true;
        root.setAttribute('aria-label', AGENDA_HEADING);

        const header = el('div', 'boardroom-agenda__header');
        header.appendChild(el('h2', 'boardroom-agenda__title', AGENDA_HEADING));
        const refresh = el('button', 'boardroom-agenda__action', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', () => this.load());
        const close = el('button', 'boardroom-agenda__action', 'Close');
        close.type = 'button';
        close.addEventListener('click', () => this.close());
        header.append(refresh, close);

        this.statusEl = el('p', 'boardroom-agenda__status');
        this.statusEl.setAttribute('role', 'status');
        this.bodyEl = el('div', 'boardroom-agenda__body');
        root.append(header, this.statusEl, this.bodyEl);

        const messagesEl = this.app.elements?.messagesContainer;
        if (messagesEl?.parentNode) messagesEl.before(root);
        else this.app.appendChild(root);
        this.root = root;
    }

    setStatus(message) {
        if (!this.statusEl) return;
        this.statusEl.textContent = message || '';
        this.statusEl.hidden = !message;
    }

    /** Fetch the owner view; concurrent calls share one request. */
    load() {
        if (this.loading) return this.loading;
        const client = this.app.copilotKit;
        if (!client) {
            this.setStatus(AGENDA_UNAVAILABLE);
            return Promise.resolve();
        }
        this.setStatus(AGENDA_LOADING);
        this.loading = (async () => {
            try {
                const body = await client.fetchAgenda();
                const requestedAt = Date.now();
                this.view = normalizeAgendaView(body);
                this.clockOffset = this.view.now !== null ? this.view.now - requestedAt : 0;
                this.setStatus(this.view.enabled ? '' : AGENDA_DISABLED);
                this.render();
            } catch (error) {
                this.view = null;
                this.render();
                this.handleError(error, AGENDA_UNAVAILABLE);
            }
        })().finally(() => { this.loading = null; });
        return this.loading;
    }

    handleError(error, fallback) {
        if (error?.status === 401 || error?.status === 403) {
            this.setStatus('');
            this.app.authGate.onRejected(error);
            return;
        }
        if (error?.code === 'agenda_disabled') {
            this.setStatus(AGENDA_DISABLED);
            return;
        }
        if (error?.status === 404 && !error?.code) {
            this.setStatus(AGENDA_UNAVAILABLE);
            return;
        }
        this.setStatus(fallback);
        this.app.chatLog?.errorNote?.(error);
    }

    render() {
        if (!this.bodyEl) return;
        const view = this.view;
        if (!view || !view.enabled) {
            this.bodyEl.replaceChildren();
            return;
        }
        const nowMs = this.now();

        const decisions = el('ol', 'boardroom-agenda__decisions');
        view.decisions.forEach((d) => decisions.appendChild(this.renderDecision(d, nowMs)));

        const digest = el('ul', 'boardroom-agenda__digest');
        view.digest.decisions.forEach((d) => digest.appendChild(el('li', 'boardroom-agenda__digest-line', digestLine(d))));
        const more = digestMoreLine(view.digest.more);

        this.bodyEl.replaceChildren(
            el('h3', 'boardroom-agenda__heading', AGENDA_DECISIONS_HEADING),
            view.decisions.length ? decisions : el('p', 'boardroom-agenda__empty', AGENDA_EMPTY_DECISIONS),
            el('h3', 'boardroom-agenda__heading', AGENDA_DIGEST_HEADING),
            view.digest.decisions.length ? digest : el('p', 'boardroom-agenda__empty', AGENDA_EMPTY_DIGEST),
            ...(more ? [el('p', 'boardroom-agenda__digest-more', more)] : []),
        );
    }

    /** Update each window left in place; drop a veto form once its window closes. */
    tick() {
        if (!this.bodyEl || !this.view?.enabled) return;
        const nowMs = this.now();
        this.view.decisions.forEach((d) => {
            const li = [...this.bodyEl.querySelectorAll('.boardroom-agenda__decision')]
                .find((node) => node.dataset.item === d.item);
            if (!li) return;
            const windowEl = li.querySelector('.boardroom-agenda__window');
            if (windowEl) windowEl.textContent = formatWindowLeft(vetoWindowLeftMs(d, nowMs, this.view.vetoWindowHours));
            if (!canVeto(d, nowMs, this.view.vetoWindowHours)) li.querySelector('.boardroom-agenda__veto')?.remove();
        });
    }

    renderDecision(d, nowMs) {
        const li = el('li', 'boardroom-agenda__decision');
        li.dataset.status = d.status;
        li.dataset.item = d.item;
        li.appendChild(el('div', 'boardroom-agenda__item', `[${d.item}] ${d.title}`));

        const fields = el('dl', 'boardroom-agenda__fields');
        const left = vetoWindowLeftMs(d, nowMs, this.view.vetoWindowHours);
        [
            ['Decision', d.text],
            ['Reason', d.reason],
            ['Forecast', d.forecast],
            ['Level', AGENDA_LEVEL_LABELS[d.level] || d.level],
            ['Deciders', d.deciders.join(', ')],
            ['Decided', formatTime(d.decidedAt)],
            ['Effective', formatTime(d.effectiveAt)],
            ['Status', AGENDA_STATUS_LABELS[d.status] || d.status],
            ['Veto window', formatWindowLeft(left)],
        ].forEach(([label, value]) => {
            const valueEl = el('dd', 'boardroom-agenda__value', value || '—');
            if (label === 'Veto window') valueEl.classList.add('boardroom-agenda__window');
            fields.append(el('dt', 'boardroom-agenda__label', label), valueEl);
        });
        li.appendChild(fields);

        const reversal = d.vetoed || d.calledIn;
        if (reversal) {
            const who = d.vetoed ? 'Vetoed' : 'Called in';
            const by = reversal.by ? ` by ${reversal.by}` : '';
            li.appendChild(el('p', 'boardroom-agenda__reversal', `${who}${by}: ${reversal.reason}`));
        }

        if (canVeto(d, nowMs, this.view.vetoWindowHours)) li.appendChild(this.renderVetoForm(d));
        return li;
    }

    renderVetoForm(d) {
        const form = el('form', 'boardroom-agenda__veto');
        const id = `boardroom-agenda-veto-${d.item.replace(/\W/g, '-')}`;
        const label = el('label', 'boardroom-agenda__veto-label', AGENDA_VETO_REASON_LABEL);
        label.htmlFor = id;
        const reason = el('textarea', 'boardroom-agenda__veto-reason');
        reason.id = id;
        reason.name = 'reason';
        reason.required = true;
        reason.maxLength = MAX_USER_TEXT_CHARS;
        reason.rows = 2;
        const submit = el('button', 'boardroom-agenda__veto-submit', AGENDA_VETO_SUBMIT);
        submit.type = 'submit';
        form.append(label, reason, submit);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            this.veto(d, reason.value, submit);
        });
        return form;
    }

    /**
     * Veto a decision with a reason. Allowed only inside the window; O
     * refuses outside it (409 `veto_window_closed`) and the view reloads.
     * @returns {Promise<boolean>} true when the veto was recorded.
     */
    async veto(decision, reasonValue, submitEl = null) {
        const reason = vetoReason(reasonValue);
        if (!reason) {
            this.app.showToast('A reason is required to veto a decision', 'warning');
            return false;
        }
        if (!canVeto(decision, this.now(), this.view?.vetoWindowHours)) {
            this.app.showToast(AGENDA_VETO_CLOSED, 'warning');
            this.render();
            return false;
        }
        if (submitEl) submitEl.disabled = true;
        try {
            await this.app.copilotKit.vetoDecision(decision.item, reason, decision.decidedAt);
            this.app.showToast(AGENDA_VETO_DONE, 'success');
            await this.load();
            return true;
        } catch (error) {
            if (error?.code === 'veto_window_closed') {
                this.app.showToast(AGENDA_VETO_CLOSED, 'warning');
                await this.load();
                return false;
            }
            if (error?.status !== 401 && error?.status !== 403) {
                this.app.showToast(AGENDA_VETO_FAILED, 'error');
            }
            this.handleError(error, AGENDA_VETO_FAILED);
            return false;
        } finally {
            if (submitEl) submitEl.disabled = false;
        }
    }
}

export default AgendaPanel;
