/**
 * The boardroom chat's log: system notes (source + time + text), the
 * user-selectable log level, AG-UI protocol events and MSAL log entries.
 */

import { CopilotKitClient } from '../copilotkit-client.js';
import {
    LOG_LEVEL_STORAGE_KEY,
    LOG_RANKS,
    LOG_LEVEL_OPTIONS,
    NOTE_SOURCES,
} from './constants.js';

export class ChatLog {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.control = null;
    }

    level() {
        try {
            const v = localStorage.getItem(LOG_LEVEL_STORAGE_KEY);
            if (v && v in LOG_RANKS && v !== 'success') return v;
        } catch (e) { /* storage unavailable */ }
        return 'info';
    }

    allowed(level) {
        return (LOG_RANKS[level] ?? 2) <= LOG_RANKS[this.level()];
    }

    /** Inject a log-level selector above the chat messages. */
    buildControl() {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl || this.control) return;
        const wrap = document.createElement('div');
        wrap.className = 'boardroom-log-level';
        const label = document.createElement('label');
        label.textContent = 'Log level ';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Chat log level');
        const current = this.level();
        for (const [value, text] of LOG_LEVEL_OPTIONS) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            opt.selected = value === current;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            try { localStorage.setItem(LOG_LEVEL_STORAGE_KEY, select.value); } catch (e) { /* ignore */ }
            this.applyToExisting();
        });
        label.appendChild(select);
        wrap.appendChild(label);
        messagesEl.parentNode.insertBefore(wrap, messagesEl);
        this.control = wrap;
    }

    /** Re-filter notes already in the chat after the level changes. */
    applyToExisting() {
        this.app.elements?.messagesContainer?.querySelectorAll('[data-severity]').forEach((n) => {
            n.hidden = !this.allowed(n.dataset.severity);
        });
    }

    showMsalLog({ level, text }) {
        const note = this.note(`event-${level}`, `[${level.toUpperCase()}] ${text}`, 'MSAL');
        if (note) {
            note.dataset.severity = level;
            note.hidden = !this.allowed(level);
        }
        return note;
    }

    errorNote(error) {
        const code = error?.code ? ` [${error.code}]` : '';
        const status = error?.status ? ` (HTTP ${error.status})` : '';
        const detail = error?.detail || error?.message || 'Unknown error';
        const reference = error?.errorId && !detail.includes(error.errorId) ? ` (reference ${error.errorId})` : '';
        const note = this.note('event-error', `[ERROR]${code}${status}: ${detail}${reference}`);
        // A RUN_ERROR is the turn's outcome, not a log line: it is always shown.
        if (note && error?.name !== 'RunError') {
            note.dataset.severity = 'error';
            note.hidden = !this.allowed('error');
        }
    }

    /**
     * Classify an AG-UI event as a severity: error | warning | success | info.
     * Returns null for events already rendered elsewhere (text bubbles,
     * RUN_ERROR via AguiSession.handleRunError, boardroom CUSTOM events) or pure noise.
     */
    classify(event) {
        const type = String(event?.type || '');
        switch (type) {
            case 'RUN_STARTED': return { level: 'info', text: 'Run started' };
            case 'RUN_FINISHED':
                return event.result?.cancelled === true
                    ? { level: 'warning', text: 'Run cancelled' }
                    : { level: 'success', text: 'Run finished' };
            case 'STEP_STARTED': return { level: 'info', text: `Step started: ${event.stepName ?? ''}` };
            case 'STEP_FINISHED': return { level: 'info', text: `Step finished: ${event.stepName ?? ''}` };
            case 'TOOL_CALL_START': return { level: 'info', text: `Tool call: ${event.toolCallName ?? event.name ?? ''}` };
            case 'TOOL_CALL_RESULT': return { level: 'success', text: 'Tool call completed' };
            case 'STATE_SNAPSHOT': return { level: 'info', text: 'State snapshot received' };
            case 'STATE_DELTA': return { level: 'info', text: 'State updated' };
            case 'MESSAGES_SNAPSHOT': return { level: 'info', text: 'Message history synced' };
            case 'RAW': return { level: 'info', text: 'Raw event received' };
            default: return null;
        }
    }

    showProtocolEvent(event) {
        const type = String(event?.type || '');
        let c = this.classify(event);
        if (!c && type === 'CUSTOM') {
            const name = String(event.name || '');
            if (/(error|fail)/i.test(name)) c = { level: 'error', text: `${name}: ${typeof event.value === 'string' ? event.value : JSON.stringify(event.value ?? '')}` };
            else if (/(warn|conflict)/i.test(name)) c = { level: 'warning', text: `${name}: ${typeof event.value === 'string' ? event.value : JSON.stringify(event.value ?? '')}` };
            else if (!['position_stated', 'resolution', CopilotKitClient.SPEAKER_RELAY_EVENT].includes(name)) c = { level: 'info', text: `Event: ${name}` };
        }
        if (!c) return;
        const note = this.note(`event-${c.level}`, `[${c.level.toUpperCase()}] ${c.text}`);
        if (note) {
            note.dataset.severity = c.level;
            note.hidden = !this.allowed(c.level);
        }
    }

    note(kind, text, source) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl) return null;
        const note = document.createElement('div');
        note.className = `chatroom__message chatroom__message--system boardroom-note boardroom-note--${kind}`;
        note.setAttribute('role', 'status');
        const header = document.createElement('div');
        header.className = 'boardroom-note__meta';
        const src = document.createElement('span');
        src.className = 'boardroom-note__source';
        src.textContent = source || NOTE_SOURCES[kind] || 'Boardroom';
        const time = document.createElement('time');
        time.className = 'boardroom-note__time';
        time.dateTime = new Date().toISOString();
        time.textContent = this.app._formatNow();
        header.append(src, time);
        const body = document.createElement('div');
        body.className = 'boardroom-note__text';
        body.textContent = text;
        note.append(header, body);
        messagesEl.appendChild(note);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return note;
    }
}

export default ChatLog;
