/**
 * Boardroom-specific chrome on the static chatroom shell: header actions
 * (screen share, video call, the admin-only agenda, more), formatting and file-attach toolbar
 * buttons, and their handlers.
 */

import { AGENDA_BUTTON_LABEL } from './constants.js';

export class BoardroomChrome {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
    }

    /**
     * Add boardroom-specific action buttons (Screen Share, Video Call, More Options)
     * into the static header's .chatroom-actions container.
     * @param {Element} rootEl  Component root
     */
    addHeaderActions(rootEl) {
        const actionsEl = rootEl.querySelector('.chatroom-actions');
        if (!actionsEl) return;

        const cdnBase = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons';

        if (this.app.boardroomConfig.enableVideoCall) {
            const btn = document.createElement('button');
            btn.className = 'chatroom-header-btn boardroom-action-btn';
            btn.title = 'Video Call';
            btn.setAttribute('aria-label', 'Video Call');
            const img = document.createElement('img');
            img.src = `${cdnBase}/camera-video.svg`;
            img.alt = 'Video Call';
            img.width = 18;
            img.height = 18;
            btn.appendChild(img);
            actionsEl.insertBefore(btn, actionsEl.firstChild);
        }

        if (this.app.boardroomConfig.enableScreenShare) {
            const btn = document.createElement('button');
            btn.className = 'chatroom-header-btn boardroom-action-btn';
            btn.title = 'Screen Share';
            btn.setAttribute('aria-label', 'Screen Share');
            const img = document.createElement('img');
            img.src = `${cdnBase}/display.svg`;
            img.alt = 'Screen Share';
            img.width = 18;
            img.height = 18;
            btn.appendChild(img);
            actionsEl.insertBefore(btn, actionsEl.firstChild);
        }

        // Owner's agenda (decisions, consent digest, veto): administrators
        // only, shown by AuthGate.applyCapabilities().
        const agendaBtn = document.createElement('button');
        agendaBtn.type = 'button';
        agendaBtn.className = 'chatroom-header-btn boardroom-action-btn';
        agendaBtn.title = AGENDA_BUTTON_LABEL;
        agendaBtn.setAttribute('aria-label', AGENDA_BUTTON_LABEL);
        agendaBtn.setAttribute('aria-controls', 'boardroom-agenda');
        agendaBtn.setAttribute('aria-expanded', 'false');
        agendaBtn.setAttribute('data-boardroom-admin', '');
        agendaBtn.setAttribute('data-boardroom-agenda-toggle', '');
        agendaBtn.hidden = true;
        const agendaImg = document.createElement('img');
        agendaImg.src = `${cdnBase}/list-check.svg`;
        agendaImg.alt = AGENDA_BUTTON_LABEL;
        agendaImg.width = 18;
        agendaImg.height = 18;
        agendaBtn.appendChild(agendaImg);
        actionsEl.appendChild(agendaBtn);

        const moreBtn = document.createElement('button');
        moreBtn.className = 'chatroom-header-btn boardroom-action-btn';
        moreBtn.title = 'More Options';
        moreBtn.setAttribute('aria-label', 'More Options');
        const moreImg = document.createElement('img');
        moreImg.src = `${cdnBase}/three-dots.svg`;
        moreImg.alt = 'More Options';
        moreImg.width = 18;
        moreImg.height = 18;
        moreBtn.appendChild(moreImg);
        actionsEl.appendChild(moreBtn);
    }

    /**
     * Add boardroom formatting buttons (Bold, Italic, Code) into the
     * static toolbar's existing left slot.
     * @param {Element} inputEl  Static .chatroom-input element
     */
    addFormattingButtons(inputEl) {
        const toolbarLeft = inputEl.querySelector('.chatroom-input-toolbar-left');
        if (!toolbarLeft) return;

        const cdnBase = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons';
        const formatButtons = [
            { title: 'Bold', icon: 'type-bold' },
            { title: 'Italic', icon: 'type-italic' },
            { title: 'Code', icon: 'code' },
        ];

        formatButtons.forEach(({ title, icon }) => {
            const btn = document.createElement('button');
            btn.className = 'chatroom-input-format-btn';
            btn.type = 'button';
            btn.title = title;
            btn.setAttribute('aria-label', title);
            const img = document.createElement('img');
            img.src = `${cdnBase}/${icon}.svg`;
            img.alt = title;
            img.width = 14;
            img.height = 14;
            btn.appendChild(img);
            toolbarLeft.appendChild(btn);
        });
    }

    /**
     * Add a file-attach button into the static toolbar's existing right slot.
     * @param {Element} inputEl  Static .chatroom-input element
     */
    addFileAttachButton(inputEl) {
        const toolbarRight = inputEl.querySelector('.chatroom-input-toolbar-right');
        if (!toolbarRight) return;

        const btn = document.createElement('button');
        btn.className = 'chatroom-input-action-btn';
        btn.type = 'button';
        btn.title = 'Attach File';
        btn.setAttribute('aria-label', 'Attach File');
        const img = document.createElement('img');
        img.src = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons/paperclip.svg';
        img.alt = 'Attach';
        img.width = 18;
        img.height = 18;
        btn.appendChild(img);
        const sendBtn = toolbarRight.querySelector('.chatroom-input-send-btn');
        if (sendBtn) {
            toolbarRight.insertBefore(btn, sendBtn);
        } else {
            toolbarRight.appendChild(btn);
        }
    }

    /**
     * Attach boardroom-specific event handlers. Deliberately does NOT wire
     * up the toggle strip or members-sidebar search/filter — those are
     * owned entirely by chatroom-panels.js against the generic panel
     * markup. Wiring them here too would double-bind the same buttons.
     */
    attachHandlers() {
        if (this.app.boardroomElements.membersList) {
            this.app.boardroomElements.membersList.addEventListener('click', (e) => {
                const agentItem = e.target.closest('[data-agent-id]');
                if (agentItem) {
                    const agentId = agentItem.dataset.agentId;
                    this.app.membersPanel.select(agentId);
                }
            });
        }

        const screenShareBtn = this.app.querySelector('[title="Screen Share"]');
        if (screenShareBtn && this.app.boardroomConfig.enableScreenShare) {
            screenShareBtn.addEventListener('click', () => this.startScreenShare());
        }

        const videoCallBtn = this.app.querySelector('[title="Video Call"]');
        if (videoCallBtn && this.app.boardroomConfig.enableVideoCall) {
            videoCallBtn.addEventListener('click', () => this.startVideoCall());
        }

        const agendaBtn = this.app.querySelector('[data-boardroom-agenda-toggle]');
        if (agendaBtn && !agendaBtn.dataset.bound) {
            agendaBtn.dataset.bound = 'true';
            agendaBtn.addEventListener('click', () => this.app.agendaPanel.toggle());
        }

        const fileAttachBtn = this.app.querySelector('[title="Attach File"]');
        if (fileAttachBtn && this.app.boardroomConfig.enableFileAttach) {
            fileAttachBtn.addEventListener('click', () => this.attachFile());
        }
    }

    async startScreenShare() {
        this.app.showToast('Screen share initiated', 'info');
        this.app.dispatchEvent(new CustomEvent('boardroom-screen-share', { bubbles: true }));
    }

    async startVideoCall() {
        this.app.showToast('Video call initiated', 'info');
        this.app.dispatchEvent(new CustomEvent('boardroom-video-call', { bubbles: true }));
    }

    async attachFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                await this.uploadFile(file);
            }
        };
        input.click();
    }

    async uploadFile(file) {
        this.app.showToast(`Uploading ${file.name}...`, 'info');

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('conversationId', this.app.conversationId);

            const response = await this.app.msalAuth.authedFetch(`${this.app.boardroomConfig.apiBase}/files`, {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                this.app.showToast('File uploaded successfully', 'success');
            } else {
                throw new Error('Upload failed');
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            this.app.showToast('Failed to upload file', 'error');
        }
    }
}

export default BoardroomChrome;
