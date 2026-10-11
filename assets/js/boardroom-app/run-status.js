/**
 * Run status indicators: busy state, "The board is deliberating…", the 07
 * user-interjection status and the live-only (mind unavailable) banner.
 */

import {
    INTERJECTION_STATUS_TIMEOUT_MS,
    DELIBERATING_STATUS,
    LIVE_ONLY_BANNER,
} from './constants.js';

export class RunStatus {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.running = false;
        this.deliberating = null;
        this.interjection = null;
        this.liveOnlyBanner = null;
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
     * Show or remove the live-only banner (state.live_only === true: mind is
     * unreachable, so history and grounding are off). It sits above the
     * messages so re-rendering the conversation never drops it.
     */
    setLiveOnly(state) {
        const liveOnly = state?.live_only === true;
        if (!liveOnly) {
            this.liveOnlyBanner?.remove();
            this.liveOnlyBanner = null;
            return;
        }
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl?.parentNode) return;
        if (!this.liveOnlyBanner) {
            const banner = document.createElement('div');
            banner.className = 'chatroom__message chatroom__message--system boardroom-note boardroom-note--live-only';
            banner.setAttribute('role', 'status');
            const meta = document.createElement('div');
            meta.className = 'boardroom-note__meta';
            const src = document.createElement('span');
            src.className = 'boardroom-note__source';
            src.textContent = 'Boardroom';
            const time = document.createElement('time');
            time.className = 'boardroom-note__time';
            time.textContent = this.app._formatNow();
            meta.append(src, time);
            const body = document.createElement('div');
            body.className = 'boardroom-note__text';
            body.textContent = LIVE_ONLY_BANNER;
            banner.append(meta, body);
            messagesEl.parentNode.insertBefore(banner, messagesEl);
            this.liveOnlyBanner = banner;
        }
        this.liveOnlyBanner.dataset.reason = String(state.live_only_reason || '');
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
