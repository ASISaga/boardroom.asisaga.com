/**
 * The boardroom's AG-UI session through CopilotKitClient: client wiring,
 * the server-minted thread, hydrate, sends (07 user interjection) and
 * run errors.
 */

import { CopilotKitClient } from '../copilotkit-client.js';
import {
    BOARDROOM_ROSTER,
    MAX_USER_TEXT_CHARS,
    INTERJECTION_STATUS_USER,
    INTERJECTION_STATUS_AUTONOMOUS,
    PENDING_THREAD_ID,
} from './constants.js';

export class AguiSession {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.hydrating = false;
        this.onVisibility = null;
        this.onPageHide = null;
    }

    /**
     * Check the backend's sign-in checklist, then hydrate. When the user
     * cannot use the boardroom yet, the checklist replaces the chat and
     * nothing is hydrated. Re-run by the checklist's Retry button.
     */
    async start() {
        if (!this.app.copilotKit) return;
        if (!(await this.app.authGate.check())) return;

        await this.hydrate();
        if (!this.onVisibility) {
            this.onVisibility = () => {
                if (document.visibilityState === 'visible') this.hydrate();
            };
            document.addEventListener('visibilitychange', this.onVisibility);
        }
        if (!this.onPageHide) {
            // Unload aborts every in-flight run (sends and hydrates).
            this.onPageHide = () => this.app.copilotKit?.abort();
            window.addEventListener('pagehide', this.onPageHide);
        }
    }

    /**
     * Initialise the CopilotKit client that connects to the server-side
     * CopilotKit runtime (@copilotkit/sdk-js / AG-UI HTTP protocol).
     * Currently unused by sendMessage() — kept for easy revert.
     */
    init() {
        const runtimeUrl = this.app.boardroomConfig.copilotKitRuntimeUrl;
        if (!runtimeUrl) return;

        this.app.copilotKit = new CopilotKitClient({
            runtimeUrl,
            // MsalAuth.acquireToken() tries silent MSAL renewal first and only
            // falls back to an interactive redirect if that fails — see
            // its definition above for the full behavior.
            getAccessToken: () => this.app.msalAuth.acquireToken(),
            // STEP_STARTED.stepName is the speaker's role id (07); any other
            // step name is informative-only and never rendered as a speaker.
            roster: BOARDROOM_ROSTER.map((a) => a.agentId),
        });

        this.app.copilotKit.onStreamChunk = (chunk, messageId) => {
            this.app.messageView.appendChunk(chunk, messageId);
        };
        this.app.copilotKit.onMessageStart = (messageId, speaker, runId) => {
            this.app.runStatus.clearInterjectionFor(runId);
            this.app.runStatus.clearDeliberating(runId);
            this.app.messageView.createBubble(messageId, speaker);
        };
        this.app.copilotKit.onMessageEnd = (messageId, fullContent) => {
            this.app.messageView.finalizeBubble(messageId, fullContent);
        };
        this.app.copilotKit.onSpeakerRelay = (relay, messageId) => {
            this.app.messageView.renderSpeakerRelay(messageId, relay);
        };
        this.app.copilotKit.onError = (error, runId) => {
            this.app.runStatus.clearInterjectionFor(runId);
            this.app.runStatus.clearDeliberating(runId);
            this.handleRunError(error);
        };
        this.app.copilotKit.onRunStarted = (runId, threadId, source) => {
            if (source === 'hydrate') this.adoptThreadId(threadId);
            else this.app.runStatus.showDeliberating(runId);
            this.app.runStatus.sync();
        };
        this.app.copilotKit.onRunFinished = (content, runId) => {
            this.app.runStatus.clearInterjectionFor(runId);
            this.app.runStatus.clearDeliberating(runId);
            this.app.runStatus.sync();
        };
        this.app.copilotKit.onRunResult = (result) => {
            if (result && result.cancelled === true) {
                this.app.showToast('The boardroom turn was cancelled', 'info');
            }
        };
        // Only a Digest-bearing RUN_FINISHED is a completed turn (07);
        // hydrates and cancelled turns never reach here.
        this.app.copilotKit.onTurnComplete = (result, runId) => {
            this.app.dispatchEvent(new CustomEvent('boardroom-turn-complete', {
                bubbles: true,
                detail: {
                    result,
                    runId,
                    lastSeen: this.app.copilotKit.lastSeen,
                    conversationId: this.app.conversationId,
                },
            }));
        };
        this.app.copilotKit.onStepStarted = (speaker, runId) => {
            this.app.runStatus.clearInterjectionFor(runId);
            this.app.runStatus.clearDeliberating(runId);
            this.app.membersPanel.setActiveSpeaker(speaker);
        };
        this.app.copilotKit.onStepFinished = (speaker) => {
            if (this.app.membersPanel.activeSpeaker && this.app.membersPanel.activeSpeaker === String(speaker || '').toLowerCase()) {
                this.app.membersPanel.setActiveSpeaker(null);
            }
        };
        this.app.copilotKit.onProtocolEvent = (event) => this.app.chatLog.showProtocolEvent(event);
        this.app.copilotKit.onCustomEvent = (name, value) => this.handleBoardroomEvent(name, value);
        this.app.copilotKit.onStateChange = (state) => {
            // A hydrate's snapshot always says whether mind answered; a turn's
            // state only changes the banner when it carries live_only itself.
            if (this.hydrating || (state && 'live_only' in state)) this.app.runStatus.setLiveOnly(state);
            const away = Number(state?.since_you_were_away || 0);
            if (away > 0 && this.hydrating) {
                this.app.showToast(`${away} boardroom decision${away === 1 ? '' : 's'} while you were away`, 'info');
            }
            this.app.dispatchEvent(new CustomEvent('boardroom-agent-state', {
                bubbles: true,
                detail: { state, conversationId: this.app.conversationId },
            }));
        };
        this.app.copilotKit.onMessagesSnapshot = (messages) => this.app.messageView.renderSnapshot(messages);
        this.syncThread();
    }

    /**
     * The boardroom is one company-wide room: a single thread, not one per
     * selected agent. The backend resolves the company from the token's
     * tenant and mints the thread id, so start from a placeholder until the
     * hydrate's RUN_STARTED carries the real one (see adoptThreadId).
     */
    syncThread() {
        if (!this.app.copilotKit) return;
        this.app.conversationId = PENDING_THREAD_ID;
        this.app.copilotKit.setThread(this.app.conversationId);
    }

    /** Adopt the server-minted thread id from a hydrate's RUN_STARTED. */
    adoptThreadId(threadId) {
        if (!this.app.copilotKit || !threadId || threadId === this.app.conversationId) return;
        this.app.conversationId = threadId;
        this.app.copilotKit.setThread(threadId);
    }

    handleRunError(error) {
        console.error('[Boardroom] AG-UI error:', error);
        this.app.runStatus.sync();
        this.app.hideLoading();
        if (error?.status === 401 || error?.status === 403) {
            // Token, organization or role: F's checklist says which, and who must act.
            this.app.authGate.onRejected(error);
            return;
        }
        this.app.chatLog.errorNote(error);
        // RUN_ERROR codes from the backend (07 turn_failed / sanitization).
        if (error?.code === 'SanitizationRejected') {
            this.app.showToast('Your message could not be accepted – please rephrase it and retry', 'error');
            return;
        }
        if (error?.name === 'RunError') {
            // RUN_ERROR.message is for the user (e.g. a truncated turn).
            this.app.showToast(error.message || 'The boardroom turn failed – please try again', 'error');
            return;
        }
        if (error?.action === 'contact_support') {
            const reference = error.errorId ? `, quoting reference ${error.errorId}` : '';
            this.app.showToast(`Boardroom could not complete the request – contact support${reference}`, 'error');
            return;
        }
        this.app.showToast(
            error?.action === 'retry' || error?.status === 502 || error?.status === 503
                ? 'Boardroom is temporarily unavailable – please retry'
                : 'AI response error – please try again',
            'error'
        );
    }

    /** Boardroom-level CUSTOM events: position_stated, resolution, state_conflict. */
    handleBoardroomEvent(name, value) {
        let text = null;
        if (name === 'position_stated') {
            const who = value?.actor || 'Board member';
            text = `${who} — ${value?.position ?? 'position'}${value?.summary ? `: ${value.summary}` : ''}`;
        } else if (name === 'resolution') {
            const body = typeof value === 'string' ? value : (value?.text || value?.summary || value?.decision || JSON.stringify(value));
            text = `Resolution: ${body}`;
        } else if (name === 'state_conflict') {
            text = 'The boardroom state changed while deliberating; the latest decision may differ.';
            this.app.showToast('Boardroom state conflict detected', 'info');
        }
        if (text) this.app.chatLog.note(name, text);
        this.app.dispatchEvent(new CustomEvent(`boardroom-${String(name).replace(/_/g, '-')}`, {
            bubbles: true,
            detail: { name, value, conversationId: this.app.conversationId },
        }));
    }

    /**
     * Load the last turns from mind (server hydrate; does not invoke the
     * orchestrator). Autonomous EventGrid/cron turns surface here.
     */
    async hydrate() {
        if (!this.app.copilotKit || this.app.copilotKit.isRunning() || this.hydrating || this.app.authChecklist.blocked) return;
        this.hydrating = true;
        try {
            await this.app.copilotKit.hydrate();
            this.app.msalAuth.clearRedirectGuard();
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('[Boardroom] Hydrate failed (live-only mode):', error);
                if (error?.status === 401 || error?.status === 403) this.handleRunError(error);
            }
        } finally {
            this.hydrating = false;
            this.app.runStatus.sync();
        }
    }

    /**
     * Send the current input via the CopilotKit runtime (AG-UI HTTP protocol).
     * Renders a user bubble immediately, then streams the AI response token-by-token.
     *
     * Sending while a turn is in flight is a 07 user interjection: the new
     * message is its own AG-UI run, the in-flight turn keeps streaming, and
     * 07's status text tells the user how the message will be handled.
     */
    async send() {
        const inputEl = this.app.elements?.inputField;
        if (!inputEl || this.app.authChecklist.blocked) return;

        const text = inputEl.value.trim();
        if (!text) return;

        if (text.length > MAX_USER_TEXT_CHARS) {
            this.app.showToast(`Message too long (max ${MAX_USER_TEXT_CHARS} characters)`, 'error');
            return;
        }

        inputEl.value = '';
        if (this.app.elements.charCount) {
            this.app.elements.charCount.textContent = `0/${this.app.config.maxLength}`;
        }

        const messagesEl = this.app.elements?.messagesContainer;
        const emptyState = messagesEl?.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;

        const el = this.app._buildDomainUserMsg(text) ?? this.app._buildOwnMsg({
            text,
            time: this.app._formatNow(),
            author: 'You',
            initials: 'Y',
        });
        if (el && messagesEl) {
            messagesEl.appendChild(el);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        const runs = this.app.copilotKit.inFlightRuns();
        const turnInFlight = runs.some((r) => r.source !== 'hydrate');
        const autonomous = this.app.runStatus.autonomousTurnInFlight();
        if (turnInFlight || autonomous) {
            this.app.runStatus.showInterjection(
                autonomous ? INTERJECTION_STATUS_AUTONOMOUS : INTERJECTION_STATUS_USER,
                runs.map((r) => r.runId),
            );
        }

        try {
            await this.app.copilotKit.sendMessage(text);
        } catch (error) {
            // RUN_ERROR (error.code) and HTTP failures are surfaced via onError.
            if (error.name !== 'AbortError') {
                console.error('[CopilotKit] sendMessage failed:', error);
            }
        } finally {
            this.app.runStatus.sync();
        }
    }
}

export default AguiSession;
