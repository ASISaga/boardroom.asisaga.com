/**
 * Streamed speaker messages. These build/update chatroom__* message
 * elements (the same templates ChatroomApp itself uses) so streamed AG-UI
 * responses look identical to non-streamed agent messages, plus each
 * speaker's collapsible Mind / Prompt / Inference relay panel.
 */

import {
    FOUNDRY_TRACE_LINK_TEXT,
    FOUNDRY_TRACE_URL,
    RELAY_IDENTIFIER_LABELS,
    RELAY_PANEL_SUMMARY,
    RELAY_SECTIONS,
} from './constants.js';

export class MessageView {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
    }

    renderSnapshot(messages) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl || !Array.isArray(messages) || !messages.length) return;
        this.app.clearMessages();
        const emptyState = messagesEl.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;
        messages.forEach((m, i) => {
            const id = `snapshot-${m.id ?? i}`;
            if (m.role === 'user') {
                const el = this.app._buildDomainUserMsg(m.content) ?? this.app._buildOwnMsg({
                    text: m.content, time: '', author: 'You', initials: 'Y',
                });
                if (el) messagesEl.appendChild(el);
                return;
            }
            this.createBubble(id, m.name || 'Boardroom');
            this.finalizeBubble(id, String(m.content ?? ''));
        });
    }

    createBubble(messageId, agentName) {
        const messagesEl = this.app.elements?.messagesContainer;
        if (!messagesEl) return;

        const el = this.app._cloneDomainAgentTemplate();
        if (!el) return;

        el.id = `copilotkit-msg-${messageId}`;

        const info = this.app.membersPanel.speakerInfo(agentName);
        const agent = info?.name || agentName || 'Boardroom';
        const role = info?.role || 'Board member';

        const avatarEl = el.querySelector('.chatroom__avatar');
        if (avatarEl) {
            avatarEl.classList.add('chatroom__avatar--ai');
        }

        const authorEl = el.querySelector('.chatroom__author');
        if (authorEl) {
            authorEl.textContent = agent;
            authorEl.hidden = false;
        }

        const roleEl = el.querySelector('.chatroom__agent-role');
        if (roleEl) {
            roleEl.textContent = role;
            roleEl.hidden = false;
        }

        const textEl = el.querySelector('.chatroom__text');
        if (textEl) {
            textEl.id = `copilotkit-bubble-${messageId}`;
            textEl.textContent = '';
        }

        const timeEl = el.querySelector('.chatroom__time');
        if (timeEl) {
            timeEl.id = `copilotkit-time-${messageId}`;
            timeEl.textContent = this.app._formatNow();
            timeEl.hidden = false;
        }

        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /** Bubble element ids embed the messageId (`<turn_id>:<role>`), so escape it for selectors. */
    bubbleSelector(prefix, messageId) {
        const id = `${prefix}-${messageId}`;
        return `#${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}`;
    }

    appendChunk(chunk, messageId) {
        const textEl = this.app.querySelector(this.bubbleSelector('copilotkit-bubble', messageId));
        if (!textEl) return;

        textEl.appendChild(document.createTextNode(chunk));

        const messagesEl = this.app.elements?.messagesContainer;
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    finalizeBubble(messageId, fullContent) {
        const textEl = this.app.querySelector(this.bubbleSelector('copilotkit-bubble', messageId));
        // A speaker with no speech (e.g. the chair, whose routing is a trace
        // line, not speech) has no speech bubble.
        if (!String(fullContent ?? '').trim() && !textEl?.textContent.trim()) {
            this.app.querySelector(this.bubbleSelector('copilotkit-msg', messageId))?.remove();
            return;
        }
        if (textEl && textEl.textContent.trim() !== fullContent.trim()) {
            textEl.textContent = fullContent;
        }

        const timeEl = this.app.querySelector(this.bubbleSelector('copilotkit-time', messageId));
        if (timeEl) {
            timeEl.textContent = this.app._formatNow();
        }

        const messagesEl = this.app.elements?.messagesContainer;
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    /**
     * Attach (or refresh) the collapsible "Mind / Prompt / Inference" panel
     * on a speaker's bubble. A relay with no text is nothing to show. Text
     * only: prompts carry user and company data and are never parsed as HTML.
     */
    renderSpeakerRelay(messageId, relay) {
        const bubble = this.app.querySelector(this.bubbleSelector('copilotkit-msg', messageId));
        if (!bubble || !relay || typeof relay !== 'object') return;
        const sections = RELAY_SECTIONS.filter(([key]) => typeof relay[key] === 'string' && relay[key]);
        const ids = RELAY_IDENTIFIER_LABELS.filter(([key]) => relay[key] != null && relay[key] !== '');
        if (!sections.length && !ids.length) return;

        let panel = bubble.querySelector('.boardroom-relay');
        if (!panel) {
            panel = document.createElement('details');
            panel.className = 'boardroom-relay';
            const textEl = bubble.querySelector('.chatroom__text');
            if (textEl) textEl.after(panel);
            else bubble.appendChild(panel);
        }
        const summary = document.createElement('summary');
        summary.className = 'boardroom-relay__summary';
        summary.textContent = RELAY_PANEL_SUMMARY;
        const traceId = typeof relay.otel_trace_id === 'string' && /^[0-9a-f]{32}$/i.test(relay.otel_trace_id)
            ? relay.otel_trace_id : null;
        const idsEl = document.createElement('dl');
        idsEl.className = 'boardroom-relay__ids';
        for (const [key, label] of ids) {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = String(relay[key]);
            idsEl.append(dt, dd);
        }
        const extras = [idsEl];
        if (traceId) {
            const link = document.createElement('a');
            link.className = 'boardroom-relay__trace-link';
            link.href = FOUNDRY_TRACE_URL + encodeURIComponent(traceId);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = FOUNDRY_TRACE_LINK_TEXT;
            extras.push(link);
        }
        panel.replaceChildren(summary, ...extras, ...sections.map(([key, label]) => {
            const section = document.createElement('div');
            section.className = `boardroom-relay__section boardroom-relay__section--${key.replace(/_/g, '-')}`;
            const labelEl = document.createElement('div');
            labelEl.className = 'boardroom-relay__label';
            labelEl.textContent = label;
            const textEl = document.createElement('pre');
            textEl.className = 'boardroom-relay__text';
            textEl.textContent = relay[key];
            section.append(labelEl, textEl);
            return section;
        }));
    }
}

export default MessageView;
