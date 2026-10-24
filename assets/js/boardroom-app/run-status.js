/**
 * Run status indicators: busy state, "The board is deliberating…", the 07
 * user-interjection status and the memory banner (mind unavailable: its
 * cause, what it affects, the retry state and a "Retry now" button).
 */

import {
    INTERJECTION_STATUS_TIMEOUT_MS,
    DELIBERATING_STATUS,
    LIVE_ONLY_TITLE,
} from './constants.js';
import {
    memoryReport,
    memoryBanner,
    historyEmpty,
    autoRetryDelay,
    pageRetryText,
    RETRY_NOW_LABEL,
    HISTORY_EMPTY_TEXT,
    HISTORY_UNAVAILABLE_EMPTY_TEXT,
} from './memory-banner-model.js';

export class RunStatus {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.running = false;
        this.deliberating = null;
        this.interjection = null;
        this.liveOnlyBanner = null;
        this.bannerState = null;
        this.retryTimer = null;
        this.retryTicker = null;
        this.pageRetryAt = null;
        this.emptyStateText = null;
    }

    /** Disable/enable the input while an AG-UI run is streaming. */
    setRunning(running) {
        this.running = running;
        this.app.classList.toggle('boardroom-app--running', running);
        const input = this.app.elements?.inputField;
        if (input) input.setAttribute('aria-busy', String(running));
    }

    /**
     * Derive the busy state from the client's in-flight runs (keyed per
     * runId), so one run ending does not mark a concurrent run as idle.
     */
    sync() {
        const running = !!this.app.copilotKit?.isRunning();
        this.setRunning(running);
        if (!running) this.app.membersPanel.setActiveSpeaker(null);
        // A run that ended without a terminal callback (e.g. aborted) drops its indicator.
        if (this.deliberating?.size) {
            const inFlight = new Set((this.app.copilotKit?.inFlightRuns() || []).map((r) => r.runId));
            for (const runId of [...this.deliberating.keys()]) {
                if (!inFlight.has(runId)) this.clearDeliberating(runId);
            }
        }
    }

    /** "The board is deliberating…" for a turn, until its first speaker step or message. */
    showDeliberating(runId) {
        if (!runId) return;
        this.deliberating ??= new Map();
        if (this.deliberating.has(runId)) return;
        const note = this.app.chatLog.note('deliberating', DELIBERATING_STATUS);
        if (note) {
            note.setAttribute('aria-live', 'polite');
            this.deliberating.set(runId, note);
        }
    }

    clearDeliberating(runId) {
        const note = this.deliberating?.get(runId);
        if (!note) return;
        note.remove();
        this.deliberating.delete(runId);
    }

    /**
     * Show, update or remove the memory banner from a hydrate's state
     * (`memory` object, or the older `live_only`). It names the cause class,
     * what is affected, whether a retry is under way and when, and offers
     * "Retry now". It sits above the messages so re-rendering the
     * conversation never drops it, and clears itself when the cause clears:
     * the page reads history again on the server's schedule, or every
     * minute when none is reported.
     */
    setLiveOnly(state) {
        this.setEmptyState(state);
        // A hydrate's snapshot always says whether mind answered: silence is "ok".
        if (!memoryReport(state)) {
            if (this.app.aguiSession?.hydrating) this.clearLiveOnly();
            return;
        }
        const banner = memoryBanner(state);
        if (!banner) {
            this.clearLiveOnly();
            return;
        }
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl?.parentNode) return;
        if (!this.liveOnlyBanner) {
            const el = document.createElement('div');
            el.className = 'chatroom__message chatroom__message--system boardroom-note boardroom-note--live-only';
            const meta = document.createElement('div');
            meta.className = 'boardroom-note__meta';
            const src = document.createElement('span');
            src.className = 'boardroom-note__source';
            src.textContent = `Boardroom · ${LIVE_ONLY_TITLE}`;
            const time = document.createElement('time');
            time.className = 'boardroom-note__time';
            meta.append(src, time);
            const body = document.createElement('div');
            body.className = 'boardroom-note__text';
            body.setAttribute('role', 'status');
            // The retry line counts down; it is outside the live region.
            const retry = document.createElement('div');
            retry.className = 'boardroom-note__retry';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'boardroom-note__retry-now';
            button.textContent = RETRY_NOW_LABEL;
            button.addEventListener('click', () => this.retryNow());
            el.append(meta, body, retry, button);
            messagesEl.parentNode.insertBefore(el, messagesEl);
            this.liveOnlyBanner = el;
        }
        this.bannerState = state;
        const el = this.liveOnlyBanner;
        el.querySelector('.boardroom-note__time').textContent = this.app._formatNow();
        const text = `${banner.causeText} ${banner.affectsText}`;
        const body = el.querySelector('.boardroom-note__text');
        if (body.textContent !== text) body.textContent = text;
        el.dataset.cause = banner.cause || '';
        el.dataset.reason = String(state?.live_only_reason || '');
        this.scheduleRetry(banner);
        this.renderRetry();
    }

    clearLiveOnly() {
        clearTimeout(this.retryTimer);
        clearInterval(this.retryTicker);
        this.retryTimer = null;
        this.retryTicker = null;
        this.pageRetryAt = null;
        this.bannerState = null;
        this.liveOnlyBanner?.remove();
        this.liveOnlyBanner = null;
    }

    /** Re-read history on the server's schedule, or the page's own. */
    scheduleRetry(banner) {
        clearTimeout(this.retryTimer);
        const delay = autoRetryDelay(banner);
        this.pageRetryAt = banner.nextRetryAt == null ? Date.now() + delay : null;
        this.retryTimer = setTimeout(() => this.retryNow(), delay);
        if (!this.retryTicker) this.retryTicker = setInterval(() => this.renderRetry(), 1000);
    }

    renderRetry() {
        const el = this.liveOnlyBanner;
        if (!el) return;
        const banner = memoryBanner(this.bannerState);
        if (!banner) return;
        const line = [banner.retryText, pageRetryText(banner, this.pageRetryAt)].filter(Boolean).join(' ');
        el.querySelector('.boardroom-note__retry').textContent = line;
    }

    /** "Retry now" (or a scheduled retry): a hydrate that asks for history again. */
    async retryNow() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const button = this.liveOnlyBanner?.querySelector('.boardroom-note__retry-now');
        if (button) button.disabled = true;
        try {
            await this.app.aguiSession?.hydrate({ retryHistory: true });
        } finally {
            if (button) button.disabled = false;
            // A skipped re-read (a turn was running) is tried again later.
            if (this.liveOnlyBanner && !this.retryTimer) {
                const banner = memoryBanner(this.bannerState);
                if (banner) this.scheduleRetry(banner);
            }
        }
    }

    /** "No history yet" reads differently from "history could not be read". */
    setEmptyState(state) {
        const emptyState = this.app.elements?.messagesContainer?.querySelector('.chatroom-empty-state');
        if (!emptyState) return;
        const target = emptyState.querySelector('p') || emptyState;
        if (this.emptyStateText == null) this.emptyStateText = target.textContent;
        const report = memoryReport(state);
        if (!report) return;
        if (historyEmpty(state)) target.textContent = HISTORY_EMPTY_TEXT;
        else if (report.status === 'unavailable') target.textContent = HISTORY_UNAVAILABLE_EMPTY_TEXT;
        else target.textContent = this.emptyStateText;
    }

    /**
     * True when a scheduled (source=eventgrid) turn is in flight: either a
     * run this client is streaming with that source, or the boardroom state
     * reporting it (`turn_in_flight.source`).
     */
    autonomousTurnInFlight() {
        const runs = this.app.copilotKit?.inFlightRuns() || [];
        if (runs.some((r) => r.source === 'eventgrid')) return true;
        return this.app.copilotKit?.state?.turn_in_flight?.source === 'eventgrid';
    }

    /**
     * Show 07's interjection status. It clears once a frame of a run that
     * was not already in flight (the user's own message) arrives, when that
     * run ends, or after a bounded timeout — whichever comes first.
     */
    showInterjection(text, inFlightRunIds) {
        this.clearInterjection();
        const note = this.app.chatLog.note('interjection', text);
        const timer = setTimeout(() => this.clearInterjection(), INTERJECTION_STATUS_TIMEOUT_MS);
        this.interjection = { note, timer, inFlight: new Set(inFlightRunIds) };
    }

    clearInterjectionFor(runId) {
        if (this.interjection && runId && !this.interjection.inFlight.has(runId)) {
            this.clearInterjection();
        }
    }

    clearInterjection() {
        if (!this.interjection) return;
        clearTimeout(this.interjection.timer);
        this.interjection.note?.remove();
        this.interjection = null;
    }
}

export default RunStatus;
