/**
 * Boardroom Web Component
 *
 * Thin extension of the generic ChatroomApp: adds business-specific
 * behavior (auth gate, agent loading, CopilotKit/AG-UI streaming, extra
 * header/toolbar buttons) on top of ChatroomApp's inherited hydration.
 *
 * BoardroomApp does not generate any structural markup. All chat UI
 * (header, messages, input) is static HTML rendered by the theme's Liquid
 * includes at build time; ChatroomApp hydrates it. BoardroomApp only adds
 * to that already-static layout via the _onLayoutBuilt / _onInputBuilt
 * hooks, which now receive the existing static elements (the component
 * root and the static .chatroom-input element respectively) rather than
 * freshly-built ones.
 *
 * The toggle strip and members sidebar shells are static HTML provided by
 * the chatroom layout (_includes/chatroom/toggle-strip.html and
 * members-sidebar.html) and their show/hide + search/filter behavior is
 * owned entirely by chatroom-panels.js. BoardroomApp's only responsibility
 * toward these panels is populating the members list's mount point
 * (#chatroomMembersList) with agent data, per the data contract:
 *   <li class="chatroom-members-sidebar__item"
 *       data-status="online|away|offline"
 *       data-name="lowercase searchable name">
 *
 * Chat messages are routed through our own Azure Function backend
 * (`${apiBase}/chat`) which forwards to the Azure AI Foundry agent.
 * The CopilotKit runtime path is left in place but no longer called
 * automatically — see `sendMessage()` below.
 *
 * A simple team-password login gate runs before the chat UI is usable.
 * The resulting token is stored in localStorage under `access_token` —
 * matching the key copilotkit-client.js already reads — and attached as a
 * Bearer token on every API request.
 *
 * TEMP (standalone chat UI testing): the login gate, agent loading, and
 * live backend/CopilotKit calls in sendMessage() are disabled below so the
 * chat interface can be exercised on its own before agent orchestration is
 * wired up. Search for "TEMP" to find and revert each change.
 */

import ChatroomApp from '/assets/js/chatroom-app.js';
import { CopilotKitClient } from '/assets/js/copilotkit-client.js';

const AUTH_TOKEN_KEY = 'access_token'; // matches copilotkit-client.js's localStorage key

class BoardroomApp extends ChatroomApp {
    constructor() {
        super();

        this.boardroomConfig = {
            showToggleStrip: this.hasAttribute('show-toggle-strip'),
            showMembersSidebar: this.hasAttribute('show-members-sidebar'),
            showAgentProfiles: this.hasAttribute('show-agent-profiles'),
            apiBase: this.getAttribute('api-base') || '/api/boardroom',
            loginEndpoint: this.getAttribute('login-endpoint') || '/api/login',
            enableScreenShare: this.hasAttribute('enable-screen-share'),
            enableVideoCall: this.hasAttribute('enable-video-call'),
            enableFileAttach: this.hasAttribute('enable-file-attach'),
            enableFormatting: this.hasAttribute('enable-formatting'),
            copilotKitRuntimeUrl: this.getAttribute('copilotkit-runtime-url') || null,
        };

        this.agents = [];
        this.currentAgent = null;
        this.conversationId = null;
        this.members = [];

        // CopilotKit client – left initialised for now but not used by
        // sendMessage(); kept so it's easy to revert if needed.
        this.copilotKit = null;

        try {
            this.authToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;
        } catch (err) {
            console.warn('[Boardroom] localStorage unavailable:', err);
            this.authToken = null;
        }
    }

    // ── Auth: login gate ─────────────────────────────────────────────────

    _isAuthenticated() {
        return !!this.authToken;
    }

    /**
     * Render a minimal password prompt over the chat area. Resolves once
     * login succeeds and this.authToken is set. This overlay is genuinely
     * dynamic/conditional UI (only shown when unauthenticated), so it
     * remains JS-generated rather than static — unlike the chat shell,
     * there is no meaningful "default" static version of a login form
     * that should always be in the DOM.
     */
    _showLoginGate() {
        return new Promise((resolve) => {
            const chatArea = this.querySelector('#chatArea') || this;

            const overlay = document.createElement('div');
            overlay.className = 'boardroom-login-gate';
            overlay.innerHTML = `
                <form class="boardroom-login-form">
                    <h2 class="boardroom-login-title">Boardroom Access</h2>
                    <input type="text" name="name" placeholder="Your name" class="boardroom-login-input" autocomplete="name" />
                    <input type="password" name="password" placeholder="Team password" class="boardroom-login-input" autocomplete="current-password" required />
                    <button type="submit" class="boardroom-login-submit">Enter</button>
                    <p class="boardroom-login-error" hidden></p>
                </form>
            `;

            const form = overlay.querySelector('.boardroom-login-form');
            const errorEl = overlay.querySelector('.boardroom-login-error');

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                errorEl.hidden = true;

                const name = form.querySelector('[name="name"]').value.trim();
                const password = form.querySelector('[name="password"]').value;

                try {
                    const res = await fetch(this.boardroomConfig.loginEndpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, password }),
                    });

                    if (!res.ok) {
                        const body = await res.json().catch(() => ({}));
                        errorEl.textContent = body.error || 'Login failed. Check the password and try again.';
                        errorEl.hidden = false;
                        return;
                    }

                    const data = await res.json();
                    this.authToken = data.token;
                    localStorage.setItem(AUTH_TOKEN_KEY, this.authToken);

                    overlay.remove();
                    resolve();
                } catch (err) {
                    console.error('[Boardroom] Login request failed:', err);
                    errorEl.textContent = 'Could not reach the server. Please try again.';
                    errorEl.hidden = false;
                }
            });

            chatArea.appendChild(overlay);
        });
    }

    async _authedFetch(url, options = {}) {
        const doFetch = () => fetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            },
        });

        let response = await doFetch();

        if (response.status === 401) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            this.authToken = null;
            await this._showLoginGate();
            response = await doFetch();
        }

        return response;
    }

    // ── Hydration hooks (called by inherited ChatroomApp._hydrate()) ──────

    /**
     * Extension hook from ChatroomApp._hydrate(): add boardroom-specific
     * toolbar buttons (formatting, file attach) into the static input
     * bar's existing toolbar slots. Does not generate the input bar
     * itself — only adds buttons into its already-static
     * .chatroom-input-toolbar-left / -right containers.
     * @param {Element} inputEl  The static .chatroom-input element.
     */
    _onInputBuilt(inputEl) {
        super._onInputBuilt(inputEl);
        if (this.boardroomConfig.enableFormatting) {
            this._addBoardroomToolbarButtons(inputEl);
        }
        if (this.boardroomConfig.enableFileAttach) {
            this._addFileAttachButton(inputEl);
        }
    }

    /**
     * Extension hook from ChatroomApp._hydrate(): add boardroom-specific
     * header action buttons into the static header's existing
     * .chatroom-actions container.
     * @param {Element} rootEl  The component root (`this`).
     */
    _onLayoutBuilt(rootEl) {
        super._onLayoutBuilt(rootEl);
        this._addBoardroomHeaderActions(rootEl);
    }

    /**
     * Add boardroom-specific action buttons (Screen Share, Video Call, More Options)
     * into the static header's .chatroom-actions container.
     * @param {Element} rootEl  Component root
     */
    _addBoardroomHeaderActions(rootEl) {
        const actionsEl = rootEl.querySelector('.chatroom-actions');
        if (!actionsEl) return;

        const cdnBase = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons';

        if (this.boardroomConfig.enableVideoCall) {
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

        if (this.boardroomConfig.enableScreenShare) {
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
    _addBoardroomToolbarButtons(inputEl) {
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
    _addFileAttachButton(inputEl) {
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

    // ── Lifecycle ────────────────────────────────────────────────────────

    async connectedCallback() {
        // Runs the inherited hydration, which calls our _onLayoutBuilt /
        // _onInputBuilt hooks above against the already-static shell.
        await super.connectedCallback();

        // Hide the initial loading overlay now that hydration has run —
        // it's no longer tied to a live connection at this stage. Without this,
        // the overlay stays visible indefinitely since hideLoading() otherwise
        // only fires after a successful agent selection.
        this.hideLoading();

        // TEMP: auth gate bypassed — chat UI only, agent orchestration wired up later
        // if (!this._isAuthenticated()) {
        //     await this._showLoginGate();
        // }

        await this.initializeBoardroom();

        this.dispatchEvent(new CustomEvent('boardroom-ready', {
            bubbles: true,
            detail: { config: { ...this.config, ...this.boardroomConfig } }
        }));
    }

    async initializeBoardroom() {
        this._initCopilotKit();

        // TEMP: agent loading disabled until backend is wired up
        // if (this.boardroomConfig.showAgentProfiles) {
        //     await this.loadAgents();
        // }

        this.attachBoardroomEventHandlers();
    }

    /**
     * Initialise the CopilotKit client that connects to the server-side
     * CopilotKit runtime (@copilotkit/sdk-js / AG-UI HTTP protocol).
     * Currently unused by sendMessage() — kept for easy revert.
     */
    _initCopilotKit() {
        const runtimeUrl = this.boardroomConfig.copilotKitRuntimeUrl;
        if (!runtimeUrl) return;

        this.copilotKit = new CopilotKitClient({ runtimeUrl });

        this.copilotKit.onStreamChunk = (chunk, messageId) => {
            this._appendStreamChunk(chunk, messageId);
        };
        this.copilotKit.onMessageStart = (messageId, agentName) => {
            this._createStreamingBubble(messageId, agentName || this.currentAgent?.name);
        };
        this.copilotKit.onMessageEnd = (messageId, fullContent) => {
            this._finalizeStreamingBubble(messageId, fullContent);
        };
        this.copilotKit.onError = (error) => {
            console.error('[CopilotKit] Error:', error);
            this.showToast('AI response error – please try again', 'error');
            this.hideLoading();
        };
    }

    initializeElements() {
        // Sets up this.elements against the inherited chatroom-* selectors
        // (title, messagesContainer, inputField, etc.), all of which now
        // target the static shell rather than JS-cloned markup.
        super.initializeElements();

        // Boardroom-specific elements. Note: toggle strip and members
        // sidebar are the shared generic panels from the chatroom layout
        // (see _includes/chatroom/toggle-strip.html and
        // members-sidebar.html) — their IDs are chatroom-prefixed, not
        // boardroom-prefixed, since chatroom-panels.js owns their
        // show/hide and filter behavior generically.
        this.boardroomElements = {
            membersList: this.querySelector('#chatroomMembersList'),
            membersCount: this.querySelector('#chatroomMembersCount'),
            profileDetail: this.querySelector('[data-boardroom-region="profile"]') || this.querySelector('#profile-detail'),
            loadingOverlay: this.querySelector('.boardroom-loading-overlay'),
            toastContainer: this.querySelector('.boardroom-toast-container'),
        };
    }

    /**
     * Attach boardroom-specific event handlers. Deliberately does NOT wire
     * up the toggle strip or members-sidebar search/filter — those are
     * owned entirely by chatroom-panels.js against the generic panel
     * markup. Wiring them here too would double-bind the same buttons.
     */
    attachBoardroomEventHandlers() {
        if (this.boardroomElements.membersList) {
            this.boardroomElements.membersList.addEventListener('click', (e) => {
                const agentItem = e.target.closest('[data-agent-id]');
                if (agentItem) {
                    const agentId = agentItem.dataset.agentId;
                    this.selectAgent(agentId);
                }
            });
        }

        const screenShareBtn = this.querySelector('[title="Screen Share"]');
        if (screenShareBtn && this.boardroomConfig.enableScreenShare) {
            screenShareBtn.addEventListener('click', () => this.startScreenShare());
        }

        const videoCallBtn = this.querySelector('[title="Video Call"]');
        if (videoCallBtn && this.boardroomConfig.enableVideoCall) {
            videoCallBtn.addEventListener('click', () => this.startVideoCall());
        }

        const fileAttachBtn = this.querySelector('[title="Attach File"]');
        if (fileAttachBtn && this.boardroomConfig.enableFileAttach) {
            fileAttachBtn.addEventListener('click', () => this.attachFile());
        }
    }

    // ── Agents / members list ───────────────────────────────────────────

    async loadAgents() {
        try {
            const response = await this._authedFetch(`${this.boardroomConfig.apiBase}/agents`);
            if (response.ok) {
                this.agents = await response.json();
                this.renderAgents();
            }
        } catch (error) {
            console.error('Error loading agents:', error);
            this.showToast('Failed to load agents', 'error');
        }
    }

    /**
     * Populate the generic members sidebar's mount point (#chatroomMembersList)
     * with one <li> per agent, following the data contract that
     * chatroom-panels.js's search/filter logic expects:
     *   class="chatroom-members-sidebar__item"
     *   data-status="online|away|offline"
     *   data-name="<lowercase name, for search matching>"
     * This content is genuinely dynamic (agent roster fetched from the
     * server), so it remains JS-generated — the mount point itself
     * (#chatroomMembersList) is static, shipped by members-sidebar.html.
     * chatroom-panels.js observes this list via MutationObserver and
     * re-applies the current filter automatically after this runs.
     */
    renderAgents() {
        if (!this.boardroomElements.membersList) return;

        this.boardroomElements.membersList.replaceChildren();

        this.agents.forEach((agent) => {
            const item = document.createElement('li');
            item.className = 'chatroom-members-sidebar__item';
            item.dataset.agentId = agent.agentId;
            item.dataset.status = agent.online ? 'online' : 'offline';
            item.dataset.name = (agent.name || '').toLowerCase();

            const avatar = document.createElement('img');
            avatar.src = agent.avatar;
            avatar.alt = agent.name;
            avatar.className = 'chatroom-members-sidebar__item-avatar';

            const info = document.createElement('div');
            info.className = 'chatroom-members-sidebar__item-info';

            const name = document.createElement('div');
            name.className = 'chatroom-members-sidebar__item-name';
            name.textContent = agent.name;

            const role = document.createElement('div');
            role.className = 'chatroom-members-sidebar__item-role';
            role.textContent = agent.role;

            info.appendChild(name);
            info.appendChild(role);

            const status = document.createElement('span');
            status.className = `chatroom-members-sidebar__item-status chatroom-members-sidebar__item-status--${item.dataset.status}`;

            item.appendChild(avatar);
            item.appendChild(info);
            item.appendChild(status);

            this.boardroomElements.membersList.appendChild(item);
        });

        if (this.boardroomElements.membersCount) {
            const onlineCount = this.agents.filter((a) => a.online).length;
            this.boardroomElements.membersCount.textContent = `${onlineCount} online`;
        }
    }

    async selectAgent(agentId) {
        this.showLoading('Connecting to agent...');

        try {
            this.boardroomElements.membersList.querySelectorAll('.chatroom-members-sidebar__item').forEach((item) => {
                item.classList.remove('chatroom-members-sidebar__item--active');
            });
            const selectedItem = this.boardroomElements.membersList.querySelector(`[data-agent-id="${agentId}"]`);
            if (selectedItem) {
                selectedItem.classList.add('chatroom-members-sidebar__item--active');
            }

            this.currentAgent = this.agents.find(a => a.agentId === agentId);

            const profileResponse = await this._authedFetch(`${this.boardroomConfig.apiBase}/agents/${agentId}`);
            if (profileResponse.ok) {
                const profile = await profileResponse.json();
                this.renderAgentProfile(profile);
            }

            // conversationId is tracked client-side; the backend /chat
            // route is stateless per-request.
            this.conversationId = `${agentId}-${Date.now()}`;
            this.clearMessages();
            this.updateTitle(this.currentAgent?.name ?? agentId);

            this.hideLoading();

            this.dispatchEvent(new CustomEvent('boardroom-agent-selected', {
                bubbles: true,
                detail: { agent: this.currentAgent, conversationId: this.conversationId }
            }));
        } catch (error) {
            console.error('Error selecting agent:', error);
            this.showToast('Failed to connect to agent', 'error');
            this.hideLoading();
        }
    }

    renderAgentProfile(profile) {
        if (!this.boardroomElements.profileDetail) return;

        this.boardroomElements.profileDetail.innerHTML = `
      <div class="boardroom-profile-header">
        <img src="${profile.avatar}" alt="${profile.name}" class="boardroom-profile-avatar">
        <h3 class="boardroom-profile-name">${profile.name}</h3>
        <p class="boardroom-profile-role">${profile.role}</p>
      </div>
      <div class="boardroom-profile-details">
        <p class="boardroom-profile-bio">${profile.bio || ''}</p>
        <div class="boardroom-profile-stats">
          <div class="boardroom-profile-stat">
            <span class="boardroom-profile-stat-label">Experience</span>
            <span class="boardroom-profile-stat-value">${profile.experience || 'N/A'}</span>
          </div>
          <div class="boardroom-profile-stat">
            <span class="boardroom-profile-stat-label">Specialization</span>
            <span class="boardroom-profile-stat-value">${profile.specialization || 'N/A'}</span>
          </div>
        </div>
      </div>
    `;
    }

    // ── Sending messages ─────────────────────────────────────────────────

    /**
     * Send the current input.
     *
     * Routes through CopilotKit when configured; otherwise falls back to
     * the inherited ChatroomApp.sendMessage(), which already handles
     * slash-commands/MCP apps and posting to config.apiEndpoint (or a
     * local echo when no apiEndpoint is set) using the inherited
     * chatroom__* message rendering into the static .chatroom-messages
     * container.
     *
     * TEMP (standalone chat UI testing): CopilotKit and the backend fallback
     * are both bypassed below in favor of a local echo, since neither is
     * wired up yet. Restore the commented-out block once agent
     * orchestration is ready.
     */
    async sendMessage() {
        // TEMP: no backend/agent wired up yet — local echo only, via the
        // inherited super.sendMessage(), which already falls back to a
        // local echo when config.apiEndpoint is unset.
        await super.sendMessage();
        return;

        /* ── Restore this block once backend/CopilotKit orchestration is ready ──

        if (this.copilotKit) {
            await this._sendViaCopilotKit();
            return;
        }

        await super.sendMessage();

        ── end restore block ── */
    }

    /**
     * Send the current input via the CopilotKit runtime (AG-UI HTTP protocol).
     * Renders a user bubble immediately, then streams the AI response token-by-token.
     */
    async _sendViaCopilotKit() {
        const inputEl = this.elements?.inputField;
        if (!inputEl) return;

        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        if (this.elements.charCount) {
            this.elements.charCount.textContent = `0/${this.config.maxLength}`;
        }

        const messagesEl = this.elements?.messagesContainer;
        const emptyState = messagesEl?.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;

        const el = this._buildDomainUserMsg(text) ?? this._buildOwnMsg({
            text,
            time: this._formatNow(),
            author: 'You',
            initials: 'Y',
        });
        if (el && messagesEl) {
            messagesEl.appendChild(el);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        try {
            await this.copilotKit.sendMessage(text, {
                context: this.currentAgent
                    ? [{ description: `Active boardroom agent: ${this.currentAgent.name} (${this.currentAgent.role || 'C-suite Executive'})` }]
                    : [],
            });
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('[CopilotKit] sendMessage failed:', error);
            }
        }
    }

    // ── CopilotKit streaming message helpers ────────────────────────────
    // These build/update chatroom__* message elements (the same templates
    // ChatroomApp itself uses) so streamed CopilotKit responses look
    // identical to non-streamed agent messages. Streamed message content is
    // genuinely dynamic, so it stays JS-generated — same as every other
    // message in the conversation.

    _createStreamingBubble(messageId, agentName) {
        const messagesEl = this.elements?.messagesContainer;
        if (!messagesEl) return;

        const el = this._cloneDomainAgentTemplate();
        if (!el) return;

        el.id = `copilotkit-msg-${messageId}`;

        const agent = agentName || this.currentAgent?.name || 'AI';
        const role = this.currentAgent?.role || 'AI Assistant';

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
            timeEl.hidden = false;
        }

        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    _appendStreamChunk(chunk, messageId) {
        const textEl = this.querySelector(`#copilotkit-bubble-${messageId}`);
        if (!textEl) return;

        textEl.appendChild(document.createTextNode(chunk));

        const messagesEl = this.elements?.messagesContainer;
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    _finalizeStreamingBubble(messageId, fullContent) {
        const textEl = this.querySelector(`#copilotkit-bubble-${messageId}`);
        if (textEl && textEl.textContent.trim() !== fullContent.trim()) {
            textEl.textContent = fullContent;
        }

        const timeEl = this.querySelector(`#copilotkit-time-${messageId}`);
        if (timeEl) {
            timeEl.textContent = this._formatNow();
        }

        const messagesEl = this.elements?.messagesContainer;
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    // ── Boardroom-specific features ─────────────────────────────────────

    async startScreenShare() {
        this.showToast('Screen share initiated', 'info');
        this.dispatchEvent(new CustomEvent('boardroom-screen-share', { bubbles: true }));
    }

    async startVideoCall() {
        this.showToast('Video call initiated', 'info');
        this.dispatchEvent(new CustomEvent('boardroom-video-call', { bubbles: true }));
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
        this.showToast(`Uploading ${file.name}...`, 'info');

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('conversationId', this.conversationId);

            const response = await this._authedFetch(`${this.boardroomConfig.apiBase}/files`, {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                this.showToast('File uploaded successfully', 'success');
            } else {
                throw new Error('Upload failed');
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            this.showToast('Failed to upload file', 'error');
        }
    }

    hideLoading() {
        if (!this.boardroomElements.loadingOverlay) return;
        this.boardroomElements.loadingOverlay.classList.remove('active');
        this.boardroomElements.loadingOverlay.style.display = 'none';
    }

    showLoading(message = 'Loading...') {
        if (!this.boardroomElements.loadingOverlay) return;
        this.boardroomElements.loadingOverlay.style.display = '';
        this.boardroomElements.loadingOverlay.querySelector('.boardroom-loading-text').textContent = message;
        this.boardroomElements.loadingOverlay.classList.add('active');
    }

    showToast(message, type = 'info') {
        if (!this.boardroomElements.toastContainer) return;

        const toast = document.createElement('div');
        toast.className = `boardroom-toast boardroom-toast-${type}`;
        toast.textContent = message;

        this.boardroomElements.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('show');
        }, 10);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    disconnectedCallback() {
        if (this.copilotKit) {
            this.copilotKit.abort();
        }
        super.disconnectedCallback();
        this.dispatchEvent(new CustomEvent('boardroom-disconnected', { bubbles: true }));
    }
}

if (!customElements.get('boardroom-app')) {
    customElements.define('boardroom-app', BoardroomApp);
}

export default BoardroomApp;
