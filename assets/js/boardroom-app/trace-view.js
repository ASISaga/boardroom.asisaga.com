/**
 * The board's work on the page (visible board, step 4 of 4; issue #75):
 * the status strip, one timeline per turn, failure cards, the operator view
 * and "Copy trace". The data logic is DOM-free in trace-model.js and
 * board-status-model.js; this class only builds elements.
 *
 * Every string from a trace entry is untrusted and set as textContent.
 * Operator entries reach the page only on an operator session (checked by
 * the server where the stream is served); the TraceStore drops any it is
 * sent on an owner session, so they are never rendered there either.
 */

import {
    TraceStore,
    TRACE_HISTORY_KEY,
    TRACE_UNAVAILABLE,
    NOT_REPORTED,
    PHASE_LABELS,
    STATE_LABELS,
    agentName,
    buildTimeline,
    contextSize,
    detailLines,
    formatClock,
    formatDuration,
    repeatsFailure,
    repeatsRouting,
    traceText,
    turnIdOfMessage,
    roleOfMessage,
} from './trace-model.js';
import {
    boardStatus,
    idleStatus,
    liveWait,
    silenceStatus,
    waitText,
} from './board-status-model.js';
import {
    TRACE_OPERATOR_VIEW_LABEL,
    TRACE_COPY_LABEL,
    TRACE_COPIED,
    TRACE_COPY_FAILED,
} from './constants.js';

const TICK_MS = 1000;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export class TraceView {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.store = new TraceStore({ operator: false });
        this.operatorView = true;
        this.turnEls = new Map();      // turnId -> section element
        this.runTurns = new Map();     // runId -> turnId
        this.runSpoke = new Set();     // runIds that carried speech
        this.strip = null;
        this.ticker = null;
        this.lastEventAt = null;
        this.lastBytesAt = null;
        this.boardState = null;        // hydrate `board_status`
    }

    get operator() {
        return this.store.operator;
    }

    /**
     * Who may open the operator view is the server's statement, never the
     * page's: GET /auth/status `capabilities.operate`, or the hydrate's
     * `trace_audience: "operator"`. Anything else is an owner session.
     */
    setOperator(operator) {
        const next = operator === true;
        if (next === this.store.operator) return;
        this.store.setOperator(next);
        this.renderAll();
        this.renderStrip();
    }

    // ── Status strip ──────────────────────────────────────────────────────

    buildStrip() {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl?.parentNode || this.strip) return;
        const strip = el('div', 'boardroom-status');
        strip.dataset.state = 'idle';
        const state = el('div', 'boardroom-status__state');
        state.setAttribute('role', 'status');
        state.setAttribute('aria-live', 'polite');
        // Ticking texts sit outside the live region, so it is not read out every second.
        const elapsed = el('div', 'boardroom-status__elapsed');
        elapsed.hidden = true;
        const wait = el('div', 'boardroom-status__wait');
        wait.hidden = true;
        const silence = el('div', 'boardroom-status__silence');
        silence.hidden = true;
        const opLabel = el('label', 'boardroom-status__operator');
        opLabel.hidden = true;
        const opInput = document.createElement('input');
        opInput.type = 'checkbox';
        opInput.checked = this.operatorView;
        opInput.addEventListener('change', () => {
            this.operatorView = opInput.checked;
            this.renderAll();
        });
        opLabel.append(opInput, document.createTextNode(` ${TRACE_OPERATOR_VIEW_LABEL}`));
        strip.append(state, elapsed, wait, silence, opLabel);
        messagesEl.parentNode.insertBefore(strip, messagesEl);
        this.strip = { root: strip, state, elapsed, wait, silence, opLabel, opInput };
        this.renderStrip();
    }

    renderStrip() {
        if (!this.strip) return;
        const now = Date.now();
        const runInFlight = (this.app.copilotKit?.inFlightRuns() || []).some((r) => r.source !== 'hydrate');
        const status = boardStatus({
            store: this.store,
            runInFlight,
            stepSpeaker: this.app.membersPanel?.activeSpeaker || null,
            boardState: this.boardState,
            now,
        });
        const s = this.strip;
        s.root.dataset.state = status.state;
        if (s.state.textContent !== status.text) s.state.textContent = status.text;
        s.elapsed.textContent = status.elapsedText;
        s.elapsed.hidden = !status.elapsedText;
        s.wait.textContent = status.waitText;
        s.wait.hidden = !status.waitText;
        const silence = silenceStatus({
            running: status.state === 'running',
            lastEventAt: this.lastEventAt,
            lastBytesAt: this.lastBytesAt,
            online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
            now,
        });
        s.silence.textContent = silence?.text || '';
        s.silence.hidden = !silence;
        s.silence.dataset.connection = silence?.connection || '';
        s.opLabel.hidden = !this.operator;
        s.opInput.checked = this.operatorView;
        return status;
    }

    ensureTicker() {
        if (this.ticker) return;
        this.ticker = setInterval(() => this.tick(), TICK_MS);
    }

    stopTicker() {
        if (!this.ticker) return;
        clearInterval(this.ticker);
        this.ticker = null;
    }

    tick() {
        const status = this.renderStrip();
        const open = this.store.openTurn();
        if (open) this.renderTurn(open.turnId);
        if (status?.state !== 'running' && !open) this.stopTicker();
    }

    // ── Stream input ──────────────────────────────────────────────────────

    /** Any bytes of a run's stream (keepalives included). */
    onActivity() {
        this.lastBytesAt = Date.now();
    }

    /** Any AG-UI event of a run. */
    onEvent(event, runId, source) {
        this.lastEventAt = Date.now();
        if (source !== 'hydrate') this.ensureTicker();
        const type = String(event?.type || '');
        if (type === 'TEXT_MESSAGE_START' || type === 'TEXT_MESSAGE_CONTENT') {
            this.runSpoke.add(runId);
            const turnId = turnIdOfMessage(event.messageId);
            if (turnId && !this.runTurns.has(runId)) this.runTurns.set(runId, turnId);
        }
        if (type === 'RUN_FINISHED' && event.result && typeof event.result === 'object' && typeof event.result.turn_id === 'string') {
            if (!this.runTurns.has(runId)) this.runTurns.set(runId, event.result.turn_id);
        }
    }

    /** One raw trace entry from the stream. */
    receive(raw, runId) {
        this.lastEventAt = Date.now();
        const { entry, turn } = this.store.receive(raw, { receivedAt: Date.now(), live: true });
        if (!entry || !turn) {
            if (this.store.droppedOperator && !this.warnedOperator) {
                // Once per page: the server should never send these to an owner.
                this.warnedOperator = true;
                console.warn('[Boardroom] Dropped operator trace entries on an owner session; the server must withhold them.');
            }
            if (turn) this.renderTurn(turn.turnId);
            return;
        }
        if (runId) this.runTurns.set(runId, entry.turnId);
        if (!turn.idleOnly) this.renderTurn(entry.turnId);
        this.ensureTicker();
        this.renderStrip();
    }

    /** A run ended: a turn whose stream carried speech but no trace says so. */
    onRunEnded(runId, source) {
        if (source === 'hydrate') {
            this.renderStrip();
            return;
        }
        const turnId = this.runTurns.get(runId);
        if (turnId && this.runSpoke.has(runId)) {
            const turn = this.store.turns.get(turnId);
            if (!turn || (!turn.entries.size && !turn.heartbeat)) {
                this.store.markUnavailable(turnId, 'this turn’s stream carried no trace');
                this.renderTurn(turnId);
            }
        }
        // A live turn that never closed is no longer running once its run ended.
        const turn = turnId ? this.store.turns.get(turnId) : null;
        if (turn && turn.isOpen) {
            turn.live = false;
            this.renderTurn(turnId);
        }
        this.runSpoke.delete(runId);
        this.runTurns.delete(runId);
        this.renderStrip();
    }

    /** True when the run's failure is already on a failure card (shown once). */
    failureShownFor(runId) {
        const turnId = this.runTurns.get(runId);
        const turn = turnId ? this.store.turns.get(turnId) : null;
        if (!turn) return false;
        const timeline = buildTimeline(turn, this.timelineOptions());
        return timeline.items.some((i) => i.kind === 'speaker' && i.failure);
    }

    // ── History ───────────────────────────────────────────────────────────

    /** The hydrate's snapshot: stored traces, the board's idle state, the audience. */
    loadState(state) {
        if (!state || typeof state !== 'object') return;
        if (state.trace_audience === 'operator') this.setOperator(true);
        if (state.board_status && typeof state.board_status === 'object') this.boardState = state.board_status;
        if (Array.isArray(state[TRACE_HISTORY_KEY])) {
            this.historyIds = this.store.loadHistory(state[TRACE_HISTORY_KEY]);
        }
        this.placeHistory();
        this.renderStrip();
    }

    /** After MESSAGES_SNAPSHOT: past turns get their timelines, in place. */
    onMessagesSnapshot(messages) {
        this.snapshotTurnIds = [];
        for (const m of Array.isArray(messages) ? messages : []) {
            const turnId = turnIdOfMessage(m?.id);
            if (turnId && !this.snapshotTurnIds.includes(turnId)) this.snapshotTurnIds.push(turnId);
        }
        for (const turnId of this.snapshotTurnIds) {
            this.store.markUnavailable(turnId, 'the history read carried no trace for this turn');
        }
        this.placeHistory();
    }

    placeHistory() {
        const ids = [...(this.historyIds || [])];
        for (const id of this.snapshotTurnIds || []) if (!ids.includes(id)) ids.push(id);
        ids.forEach((turnId, i) => {
            const turn = this.store.turns.get(turnId);
            if (!turn || turn.idleOnly) return;
            this.renderTurn(turnId, { anchorIds: ids.slice(i + 1) });
        });
    }

    // ── Turn timelines ────────────────────────────────────────────────────

    timelineOptions() {
        return { operator: this.operator, operatorView: this.operatorView };
    }

    renderAll() {
        for (const turnId of this.turnEls.keys()) this.renderTurn(turnId);
    }

    firstBubbleOf(turnId) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl) return null;
        for (const node of messagesEl.children) {
            const id = node.id || '';
            if (!id.startsWith('copilotkit-msg-')) continue;
            if (turnIdOfMessage(id.slice('copilotkit-msg-'.length)) === turnId) return node;
        }
        return null;
    }

    bubbleOf(turnId, agent) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl) return null;
        for (const node of messagesEl.children) {
            const id = (node.id || '').replace(/^copilotkit-msg-/, '');
            if (id === node.id) continue;
            if (turnIdOfMessage(id) === turnId && roleOfMessage(id) === agent) return node;
        }
        return null;
    }

    /** Put the turn's element in the messages: before its speech, else after what came before. */
    place(section, turnId, anchorIds = []) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl) return;
        const anchor = (id) => {
            const other = this.turnEls.get(id);
            return other?.isConnected ? other : this.firstBubbleOf(id);
        };
        const before = this.firstBubbleOf(turnId) || anchorIds.map(anchor).find(Boolean) || null;
        // Already in place: nothing to anchor to, or right before its anchor.
        if (section.isConnected && (!before || section.nextElementSibling === before)) return;
        const emptyState = messagesEl.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;
        if (before && before.parentNode === messagesEl) messagesEl.insertBefore(section, before);
        else messagesEl.appendChild(section);
    }

    renderTurn(turnId, { anchorIds = [] } = {}) {
        const turn = this.store.turns.get(turnId);
        if (!turn || turn.idleOnly) return;
        let section = this.turnEls.get(turnId);
        let fresh = false;
        if (!section) {
            section = el('section', 'boardroom-turn');
            section.dataset.turnId = turnId;
            this.turnEls.set(turnId, section);
            fresh = true;
        }
        const timeline = buildTimeline(turn, this.timelineOptions());
        const now = Date.now();
        section.dataset.status = timeline.status;

        const prior = section.querySelector('.boardroom-turn__details');
        // Re-rendering (every tick of a running turn) keeps open panels open and focus in place.
        const openKeys = new Set([...section.querySelectorAll('details[data-key]')]
            .filter((d) => d.open).map((d) => d.dataset.key));
        const focused = typeof document !== 'undefined' && section.contains(document.activeElement)
            ? document.activeElement.closest('[data-key]')?.dataset.key : null;
        const details = el('details', 'boardroom-turn__details');
        details.open = prior ? prior.open : true;
        details.append(this.headerEl(timeline), ...this.bodyEls(turn, timeline, now));
        for (const d of details.querySelectorAll('details[data-key]')) {
            if (openKeys.has(d.dataset.key)) d.open = true;
        }
        section.replaceChildren(details);
        if (focused) {
            const target = section.querySelector(`[data-key="${focused}"]`);
            (target?.matches('details') ? target.querySelector('summary') : target)?.focus();
        }

        this.place(section, turnId, anchorIds);
        this.hideRepeats(turnId, timeline);
        const messagesEl = this.app.elements?.messagesContainer;
        if (fresh && messagesEl && turn.live) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    headerEl(timeline) {
        const status = {
            running: 'running',
            closed: timeline.summary?.state === 'failed' ? 'ended with a failure' : 'finished',
            idle: 'idle',
            unavailable: TRACE_UNAVAILABLE.toLowerCase(),
            incomplete: 'incomplete',
        }[timeline.status] || timeline.status;
        const opened = timeline.opened?.startedAt != null ? ` · opened ${formatClock(timeline.opened.startedAt)}` : '';
        return el('summary', 'boardroom-turn__header', `The board’s work on this turn${opened} · ${status}`);
    }

    bodyEls(turn, timeline, now) {
        const out = [];
        if (timeline.unavailable && !turn.entries.size) {
            out.push(el('p', 'boardroom-turn__unavailable', `${TRACE_UNAVAILABLE}: ${timeline.unavailable}.`));
            return out;
        }
        if (timeline.opened) {
            const o = timeline.opened;
            const subject = o.agendaItem ? ` Agenda item ${o.agendaItem}${o.title ? `: ${o.title}` : ''}.` : '';
            out.push(el('p', 'boardroom-turn__opened', `${o.summary || 'A turn opened.'}${subject}`));
        } else if (timeline.openedMissing) {
            out.push(el('p', 'boardroom-turn__missing', `${NOT_REPORTED}: how this turn opened.`));
        }
        const list = el('ol', 'boardroom-turn__timeline');
        const wait = liveWait(timeline.heartbeat, now);
        for (const item of timeline.items) {
            if (item.kind === 'routing') {
                const li = el('li', 'boardroom-turn__routing', item.text);
                li.dataset.state = item.row.running ? 'running' : item.row.state;
                list.appendChild(li);
            } else if (item.kind === 'speaker') {
                list.appendChild(this.speakerEl(item, wait, now));
            } else if (item.kind === 'board') {
                list.appendChild(this.phaseEl(item.row, now, 'boardroom-turn__board'));
            } else if (item.kind === 'idle') {
                list.appendChild(el('li', 'boardroom-turn__idle', item.text));
            } else if (item.kind === 'truncated') {
                list.appendChild(el('li', 'boardroom-turn__missing', `The trace was cut at its limit here: ${item.row.summary || 'later entries were dropped'}.`));
            } else if (item.kind === 'missing') {
                list.appendChild(el('li', 'boardroom-turn__missing',
                    `Missing from the trace: entr${item.numbers.length === 1 ? 'y' : 'ies'} ${item.numbers.map((n) => `#${n}`).join(', ')}.`));
            }
        }
        if (wait && !timeline.items.some((i) => i.kind === 'speaker' && i.agent === wait.speaker)) {
            list.appendChild(el('li', 'boardroom-turn__wait', `${agentName(wait.speaker)}: ${waitText(wait)}`));
        }
        if (list.children.length) out.push(list);
        if (timeline.invalid) {
            out.push(el('p', 'boardroom-turn__missing', `${timeline.invalid} trace entr${timeline.invalid === 1 ? 'y' : 'ies'} could not be read.`));
        }
        if (timeline.summary) {
            const p = el('p', 'boardroom-turn__summary', timeline.summary.text);
            p.dataset.state = timeline.summary.state;
            out.push(p);
        } else if (timeline.closedMissing) {
            out.push(el('p', 'boardroom-turn__missing', `${NOT_REPORTED}: how this turn closed.`));
        }
        if (this.operator) out.push(this.copyEl(turn));
        return out;
    }

    speakerEl(group, wait, now) {
        const li = el('li', 'boardroom-turn__speaker');
        li.dataset.agent = group.agent;
        if (group.state) li.dataset.state = group.state;
        const head = [group.name];
        if (group.state) head.push(group.state === 'running' ? 'speaking' : group.state);
        if (group.durationS != null) head.push(formatDuration(group.durationS));
        li.appendChild(el('div', 'boardroom-turn__speaker-name', head.join(' · ')));
        if (group.rows.length) {
            const phases = el('ol', 'boardroom-turn__phases');
            for (const row of group.rows) phases.appendChild(this.phaseEl(row, now, 'boardroom-turn__phase'));
            li.appendChild(phases);
        }
        if (wait && wait.speaker === group.agent) {
            li.appendChild(el('div', 'boardroom-turn__wait', waitText(wait)));
        }
        if (group.failure) li.appendChild(this.failureEl(group.failure));
        return li;
    }

    phaseEl(row, now, className) {
        const li = el('li', className);
        li.dataset.phase = row.phase;
        li.dataset.state = row.running ? 'running' : row.state;
        const label = PHASE_LABELS[row.phase] || row.phase;
        if (row.notReported) {
            li.dataset.state = 'not-reported';
            li.appendChild(el('span', 'boardroom-turn__phase-text', `${label}: ${NOT_REPORTED.toLowerCase()}.`));
            return li;
        }
        const parts = [label, row.running ? STATE_LABELS.started : (STATE_LABELS[row.state] || row.state)];
        if (row.startedAt != null) parts.push(`from ${formatClock(row.startedAt)}`);
        if (row.running && row.startedAt != null) {
            parts.push(`for ${formatDuration(Math.max(0, (now - row.startedAt) / 1000))} so far`);
        } else if (row.durationS != null) {
            parts.push(formatDuration(row.durationS));
        }
        li.appendChild(el('span', 'boardroom-turn__phase-text', `${parts.join(' · ')}${row.summary ? `: ${row.summary}` : ''}`));
        if (row.phase === 'context_built') {
            const size = contextSize(row.details);
            if (size) li.appendChild(el('div', 'boardroom-turn__context', size.text));
        }
        // Technical detail of any phase, on demand, for operators only.
        if (this.operator && this.operatorView) {
            const lines = detailLines({ ...row.details, ...(row.cause ? { cause: row.cause } : {}), ...(row.next ? { next: row.next } : {}) });
            if (lines.length) {
                const d = el('details', 'boardroom-turn__detail');
                d.dataset.key = `phase-${row.agent}-${row.first}`;
                d.append(el('summary', 'boardroom-turn__detail-toggle', 'Technical detail'), el('pre', 'boardroom-turn__detail-text', lines.join('\n')));
                li.appendChild(d);
            }
        }
        return li;
    }

    failureEl(card) {
        const box = el('div', 'boardroom-failure');
        box.dataset.cause = card.cause || '';
        box.append(
            el('div', 'boardroom-failure__title', card.title),
            el('p', 'boardroom-failure__text', card.text),
        );
        const tags = el('div', 'boardroom-failure__tags');
        tags.appendChild(el('span', 'boardroom-failure__cause',
            card.cause ? `Cause: ${card.causeLabel || card.cause} [${card.cause}]` : `Cause: ${NOT_REPORTED.toLowerCase()}`));
        if (card.next) tags.appendChild(el('span', 'boardroom-failure__next', `Next: ${card.nextLabel || card.next}`));
        box.appendChild(tags);
        if (card.detail) {
            const d = card.detail;
            const lines = [];
            if (d.modelRequests != null) lines.push(`Model requests: ${d.modelRequests}`);
            if (d.rateLimited != null) lines.push(`Rate-limited (429): ${d.rateLimited}`);
            if (d.waits != null) lines.push(`Waits taken: ${d.waits}${d.waitsS.length ? ` (${d.waitsS.map((w) => formatDuration(w)).join(', ')})` : ''}`);
            if (d.waitS != null) lines.push(`Time waiting: ${formatDuration(d.waitS)}`);
            if (d.elapsedS != null) lines.push(`Elapsed: ${formatDuration(d.elapsedS)}${d.budgetS != null ? ` of a ${formatDuration(d.budgetS)} budget` : ''}`);
            if (d.errorType) lines.push(`Error type: ${d.errorType}`);
            const details = el('details', 'boardroom-failure__detail');
            details.dataset.key = `failure-${card.agent}`;
            details.append(el('summary', 'boardroom-failure__detail-toggle', 'Technical detail'), el('pre', 'boardroom-failure__detail-text', lines.join('\n')));
            box.appendChild(details);
        }
        return box;
    }

    copyEl(turn) {
        const button = el('button', 'boardroom-turn__copy', TRACE_COPY_LABEL);
        button.type = 'button';
        button.dataset.key = 'copy';
        button.addEventListener('click', async () => {
            const text = traceText(turn, { operator: this.operator });
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                this.app.showToast(TRACE_COPIED, 'success');
            } catch (e) {
                this.app.showToast(TRACE_COPY_FAILED, 'error');
            }
        });
        return button;
    }

    /**
     * A failure is shown once, on its card: a speech bubble that only
     * repeats it is hidden. A bubble that only repeats the chair's routing
     * reason is hidden too: routing is not speech.
     */
    hideRepeats(turnId, timeline) {
        for (const item of timeline.items) {
            if (item.kind === 'speaker' && item.failure) {
                const bubble = this.bubbleOf(turnId, item.agent);
                const text = bubble?.querySelector('.chatroom__text')?.textContent;
                if (bubble && repeatsFailure(text, item.failure)) {
                    bubble.hidden = true;
                    bubble.dataset.boardroomRepeats = 'failure';
                }
            }
            if (item.kind === 'routing' && !item.row.running) {
                const by = String(item.row.details?.by || item.row.agent || '').toLowerCase();
                const bubble = this.bubbleOf(turnId, by);
                const text = bubble?.querySelector('.chatroom__text')?.textContent;
                if (bubble && repeatsRouting(text, item.row)) {
                    bubble.hidden = true;
                    bubble.dataset.boardroomRepeats = 'routing';
                }
            }
        }
    }

    /** A speaker's bubble finished: re-check it against the turn's trace. */
    onBubbleFinished(messageId) {
        const turnId = turnIdOfMessage(messageId);
        const turn = turnId ? this.store.turns.get(turnId) : null;
        if (turn) this.hideRepeats(turnId, buildTimeline(turn, this.timelineOptions()));
    }

    /** One idle line's text (a run, or a page load, that held no deliberation). */
    idleText() {
        return idleStatus({ store: this.store, boardState: this.boardState }).text;
    }

    close() {
        this.stopTicker();
    }
}

export default TraceView;
