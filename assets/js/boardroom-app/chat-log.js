/**
 * The boardroom chat's log: system notes (source + time + text), the
 * user-selectable log level and the board's AG-UI protocol events, labelled
 * by turn. A run that held no deliberation is one idle line (RunLogGate).
 *
 * Browser-library lines (MSAL) are never mixed into the board's events:
 * they go to a separate, collapsed "Browser library log" that is off by
 * default and honours the same level selector.
 */

import { CopilotKitClient } from '../copilotkit-client.js';
import {
    LOG_LEVEL_STORAGE_KEY,
    LOG_RANKS,
    LOG_LEVEL_OPTIONS,
    NOTE_SOURCES,
    CLIENT_LOG_SUMMARY,
    CLIENT_LOG_SHOW_LABEL,
} from './constants.js';
import { RunLogGate } from './board-status-model.js';
import { ClientLogBuffer } from './client-log-model.js';

function localStorageOrNull() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch (e) {
        return null;
    }
}

export class ChatLog {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.control = null;
        this.gate = new RunLogGate();
        this.clientLog = new ClientLogBuffer({ storage: localStorageOrNull() });
        this.clientLogEl = null;
        this.runTurns = new Map();   // runId -> turnId, for the turn label
        this.idleNote = null;
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
        this.buildClientLog(wrap);
    }

    /**
     * The browser-library log: a collapsed section after the level
     * selector, with its own switch (off by default). Its lines are kept
     * in a bounded buffer and rendered only while the switch is on.
     */
    buildClientLog(after) {
        if (this.clientLogEl || !after?.parentNode) return;
        const section = document.createElement('details');
        section.className = 'boardroom-client-log';
        const summary = document.createElement('summary');
        summary.className = 'boardroom-client-log__summary';
        summary.textContent = CLIENT_LOG_SUMMARY;
        const label = document.createElement('label');
        label.className = 'boardroom-client-log__filter';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this.clientLog.visible;
        input.addEventListener('change', () => {
            this.clientLog.setVisible(input.checked);
            this.renderClientLog();
        });
        label.append(input, document.createTextNode(` ${CLIENT_LOG_SHOW_LABEL}`));
        const list = document.createElement('ol');
        list.className = 'boardroom-client-log__lines';
        section.append(summary, label, list);
        after.after(section);
        this.clientLogEl = { section, list, input };
        this.renderClientLog();
    }

    renderClientLog() {
        if (!this.clientLogEl) return;
        const lines = this.clientLog.shown((level) => this.allowed(level)).map((e) => {
            const li = document.createElement('li');
            li.className = 'boardroom-client-log__line';
            li.dataset.severity = e.level;
            li.textContent = `${e.source} [${e.level.toUpperCase()}] ${e.text}`;
            return li;
        });
        this.clientLogEl.list.replaceChildren(...lines);
        this.clientLogEl.list.hidden = !this.clientLog.visible;
    }

    /** Re-filter notes already in the chat after the level changes. */
    applyToExisting() {
        this.app.elements?.messagesContainer?.querySelectorAll('[data-severity]').forEach((n) => {
            n.hidden = !this.allowed(n.dataset.severity);
        });
        this.renderClientLog();
    }

    /** An MSAL log entry: kept apart from the board's events, never in the chat. */
    showMsalLog({ level, text }) {
        const entry = this.clientLog.add({ source: 'MSAL', level, text });
        if (this.clientLog.visible && this.allowed(level)) this.renderClientLog();
        return entry;
    }

    /** The run's turn is known: label its log lines with it. */
    labelRun(runId, turnId) {
        if (!runId || !turnId || this.runTurns.get(runId) === turnId) return;
        this.runTurns.set(runId, turnId);
        this.app.elements?.messagesContainer?.querySelectorAll('.boardroom-note[data-run-id]').forEach((n) => {
            if (n.dataset.runId === runId) this.setTurnLabel(n, turnId);
        });
    }

    setTurnLabel(note, turnId) {
        if (!turnId || note.dataset.turnId === turnId) return;
        note.dataset.turnId = turnId;
        let label = note.querySelector('.boardroom-note__turn');
        if (!label) {
            label = document.createElement('span');
            label.className = 'boardroom-note__turn';
            note.querySelector('.boardroom-note__meta')?.appendChild(label);
        }
        label.textContent = `Turn ${turnId.slice(0, 8)}`;
    }

    /** A run held deliberation (speech or a trace entry): write its held lines. */
    markDeliberated(runId, source) {
        for (const line of this.gate.deliberated(runId, source)) this.writeLine(line, runId);
    }

    /** One idle line for a run (or page load) that held no deliberation; it replaces the last one. */
    idleLine(text) {
        this.idleNote?.remove();
        this.idleNote = this.note('idle', text);
        return this.idleNote;
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

    showProtocolEvent(event, runId, source) {
        const type = String(event?.type || '');
        let c = this.classify(event);
        if (!c && type === 'CUSTOM' && event.name !== CopilotKitClient.TRACE_EVENT) {
            const name = String(event.name || '');
            if (/(error|fail)/i.test(name)) c = { level: 'error', text: `${name}: ${typeof event.value === 'string' ? event.value : JSON.stringify(event.value ?? '')}` };
            else if (/(warn|conflict)/i.test(name)) c = { level: 'warning', text: `${name}: ${typeof event.value === 'string' ? event.value : JSON.stringify(event.value ?? '')}` };
            else if (!['position_stated', 'resolution', CopilotKitClient.SPEAKER_RELAY_EVENT].includes(name)) c = { level: 'info', text: `Event: ${name}` };
        }
        if (!runId) {
            if (c) this.writeLine(c, runId);
            return;
        }
        const { lines, idle } = this.gate.onEvent(event, runId, source, c);
        for (const line of lines) this.writeLine(line, runId);
        if (idle) this.idleLine(this.app.traceView?.idleText() || 'No round is running.');
    }

    writeLine(c, runId) {
        const note = this.note(`event-${c.level}`, `[${c.level.toUpperCase()}] ${c.text}`, undefined, { runId });
        if (note) {
            note.dataset.severity = c.level;
            note.hidden = !this.allowed(c.level);
        }
        return note;
    }

    note(kind, text, source, { runId = null } = {}) {
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
        if (runId) {
            note.dataset.runId = runId;
            if (this.runTurns.has(runId)) this.setTurnLabel(note, this.runTurns.get(runId));
        }
        messagesEl.appendChild(note);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return note;
    }
}

export default ChatLog;
