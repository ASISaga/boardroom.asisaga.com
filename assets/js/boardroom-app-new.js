/**
 * Boardroom Web Component
 * Extends the generic chatroom for business-specific features.
 * Includes: agent list, profiles, toggle strip, members sidebar.
 *
 * Chat messages are now routed through our own Azure Function backend
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

// Import ChatroomApp from the remote theme
// This path will be resolved by GitHub Pages through the remote_theme configuration
import ChatroomApp from '/assets/js/chatroom-app.js';
import { CopilotKitClient } from '/assets/js/copilotkit-client.js';

const AUTH_TOKEN_KEY = 'access_token'; // matches copilotkit-client.js's localStorage key

class BoardroomApp extends ChatroomApp {
    constructor() {
        super();

        // Boardroom-specific configuration
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

        // Boardroom state
        this.agents = [];
        this.currentAgent = null;
        this.conversationId = null;
        this.members = [];

        // CopilotKit client – left initialised for now but not used by
        // sendMessage(); kept so it's easy to revert if needed.
        this.copilotKit = null;

        // Auth state
        // Wrapped in try/catch: some browsers' Tracking Prevention / storage
        // partitioning can throw on localStorage access entirely, which would
        // otherwise kill the whole module before customElements.define() runs.
        try {
            this.authToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;
        } catch (err) {
            console.warn('[Boardroom] localStorage unavailable:', err);
            this.authToken = null;
        }
    }

    // ── Auth: login gate ─────────────────────────────────────────────────

    /**
     * True once we have a token. Does not verify it's still valid server-side
     * (a 401 from any request will trigger _showLoginGate() again).
     */
    _isAuthenticated() {
        return !!this.authToken;
    }

    /**
     * Render a minimal password prompt over the chat area. Resolves once
     * login succeeds and this.authToken is set.
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

    /**
     * Wrapper around fetch() that attaches the auth token and, on a 401,
     * re-runs the login gate once before retrying the request.
     */
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

    /**
     * Override _render() from ChatroomApp to inject the chatroom layout into the
     * boardroom's `#chatArea` container instead of replacing all children of this
     * element.  This preserves the boardroom-specific wrappers (toggle strip,
     * members sidebar, loading overlay, toast container) that live alongside the
     * chat area in the static HTML.
     *
     * Boardroom-specific header actions (Screen Share, Video Call, etc.) are
     * appended to the chatroom header's actions container after the template is
     * cloned and populated.
     */
    _render() {
        const { title, participants, placeholder, showToolbar, showConnectionStatus, mcpApps, chatMessages = [] } = this.config;

        const layout = this._cloneTemplate('template-chatroom-layout');
        if (!layout) return;

        // Populate title
        const titleEl = layout.querySelector('.chatroom-title');
        if (titleEl) titleEl.textContent = title;

        // Conditionally show participants count
        const participantsEl = layout.querySelector('.chatroom-participants');
        if (participantsEl && participants) {
            participantsEl.textContent = `${participants} agents in session`;
            participantsEl.hidden = false;
        }

        // Conditionally show connection status badge
        const statusContainer = layout.querySelector('.chatroom-status-container');
        if (statusContainer && showConnectionStatus) {
            statusContainer.hidden = false;
        }

        // Conditionally show MCP apps toggle button in the header
        const mcpToggle = layout.querySelector('.chatroom-mcp-apps-toggle');
        if (mcpToggle && mcpApps.length > 0) {
            mcpToggle.hidden = false;
        }

        // Insert MCP apps panel before the messages container
        if (mcpApps.length > 0) {
            const panel = this._buildMcpPanel(mcpApps);
            if (panel) {
                const messagesEl = layout.querySelector('.chatroom-messages');
                if (messagesEl) layout.insertBefore(panel, messagesEl);
            }
        }

        // Populate messages container with pre-loaded data
        const messagesEl = layout.querySelector('.chatroom-messages');
        if (messagesEl && chatMessages.length > 0) {
            messagesEl.replaceChildren();
            chatMessages.forEach(m => {
                const el = this._buildMessage(m);
                if (el) messagesEl.appendChild(el);
            });
        }

        // Add boardroom-specific header actions (Screen Share, Video Call, etc.)
        this._addBoardroomHeaderActions(layout);

        // Insert input area at the end of the layout
        const inputEl = this._buildInput(placeholder, showToolbar, mcpApps);
        if (inputEl) {
            // Add boardroom-specific toolbar buttons when formatting is enabled
            if (this.boardroomConfig.enableFormatting) {
                this._addBoardroomToolbarButtons(inputEl);
            }
            // Add file attach button to the toolbar
            if (this.boardroomConfig.enableFileAttach) {
                this._addFileAttachButton(inputEl);
            }
            layout.appendChild(inputEl);
        }

        // Inject into the boardroom chat area container only, preserving the
        // surrounding boardroom layout (toggle strip, members sidebar, etc.)
        const chatArea = this.querySelector('#chatArea');
        if (chatArea) {
            chatArea.replaceChildren(layout);
        } else {
            // Fallback: replace all children (same as ChatroomApp default)
            this.replaceChildren(layout);
        }

        // Scroll to bottom of any pre-loaded messages
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * Add boardroom-specific action buttons (Screen Share, Video Call, More Options)
     * to the chatroom header's actions container.
     * @param {Element} layout  Cloned chatroom-layout element
     */
    _addBoardroomHeaderActions(layout) {
        const actionsEl = layout.querySelector('.chatroom-actions');
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

        // Always show a More Options button at the end
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
     * Add boardroom formatting buttons (Bold, Italic, Code) to the toolbar's
     * left slot when `enable-formatting` is set.
     * @param {Element} inputEl  Cloned chatroom-input element
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
     * Add a file-attach button to the toolbar's right slot.
     * @param {Element} inputEl  Cloned chatroom-input element
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
        // Insert before the send button
        const sendBtn = toolbarRight.querySelector('.chatroom-input-send-btn');
        if (sendBtn) {
            toolbarRight.insertBefore(btn, sendBtn);
        } else {
            toolbarRight.appendChild(btn);
        }
    }

    async connectedCallback() {
        // Call parent connectedCallback
        await super.connectedCallback();

        // Hide the initial loading overlay now that the layout has rendered —
        // it's no longer tied to a live connection at this stage. Without this,
        // the overlay stays visible indefinitely since hideLoading() otherwise
        // only fires after a successful agent selection.
        this.hideLoading();

        // TEMP: auth gate bypassed — chat UI only, agent orchestration wired up later
        // if (!this._isAuthenticated()) {
        //     await this._showLoginGate();
        // }

        // Initialize boardroom-specific features
        await this.initializeBoardroom();

        // Emit boardroom-ready event
        this.dispatchEvent(new CustomEvent('boardroom-ready', {
            bubbles: true,
            detail: { config: { ...this.config, ...this.boardroomConfig } }
        }));
    }

    async initializeBoardroom() {
        // Initialize the CopilotKit runtime client if a URL was provided
        this._initCopilotKit();

        // TEMP: agent loading disabled until backend is wired up
        // if (this.boardroomConfig.showAgentProfiles) {
        //     await this.loadAgents();
        // }

        // Initialize toggle strip
        if (this.boardroomConfig.showToggleStrip) {
            this.initializeToggleStrip();
        }

        // Initialize members sidebar
        if (this.boardroomConfig.showMembersSidebar) {
            this.initializeMembersSidebar();
        }

        // Attach boardroom-specific event handlers
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
        // Call parent initializeElements
        super.initializeElements();

        // Get boardroom-specific elements
        this.boardroomElements = {
            toggleStrip: this.querySelector('.boardroom-members-sidebar-toggle-strip') || this.querySelector('.boardroom-toggle-strip'),
            membersSidebar: this.querySelector('.boardroom-members-sidebar'),
            agentList: this.querySelector('#membersListContainer'),
            chatArea: this.querySelector('.boardroom-chat-area'),
            profileDetail: this.querySelector('[data-boardroom-region="profile"]') || this.querySelector('#profile-detail'),
            loadingOverlay: this.querySelector('.boardroom-loading-overlay'),
            toastContainer: this.querySelector('.boardroom-toast-container')
        };
    }

    attachBoardroomEventHandlers() {
        if (this.boardroomElements.agentList) {
            this.boardroomElements.agentList.addEventListener('click', (e) => {
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

    initializeToggleStrip() {
        if (!this.boardroomElements.toggleStrip) return;

        const toggleButtons = this.boardroomElements.toggleStrip.querySelectorAll('[data-toggle-view]');
        toggleButtons.forEach(button => {
            button.addEventListener('click', () => {
                const view = button.dataset.toggleView;
                this.toggleView(view);
            });
        });

        const membersToggleBtn = this.querySelector('#toggleMembersBtn');
        if (membersToggleBtn && this.boardroomElements.membersSidebar) {
            membersToggleBtn.addEventListener('click', () => {
                const willHide = !this.boardroomElements.membersSidebar.classList.contains('hidden');
                this.boardroomElements.membersSidebar.classList.toggle('hidden', willHide);
                membersToggleBtn.setAttribute('aria-expanded', (!willHide).toString());

                const icon = this.querySelector('#membersSidebarToggleIcon img');
                if (icon) {
                    icon.setAttribute('alt', willHide ? 'Expand' : 'Collapse');
                }
            });
        }
    }

    initializeMembersSidebar() {
        if (!this.boardroomElements.membersSidebar) return;

        const searchInput = this.boardroomElements.membersSidebar.querySelector('.boardroom-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filterMembers(e.target.value);
            });
        }
    }

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

    renderAgents() {
        if (!this.boardroomElements.agentList) return;

        this.boardroomElements.agentList.innerHTML = '';

        this.agents.forEach(agent => {
            const agentItem = document.createElement('div');
            agentItem.className = 'boardroom-agent-item';
            agentItem.dataset.agentId = agent.agentId;
            agentItem.innerHTML = `
        <img src="${agent.avatar}" alt="${agent.name}" class="boardroom-agent-avatar">
        <div class="boardroom-agent-info">
          <div class="boardroom-agent-name">${agent.name}</div>
          <div class="boardroom-agent-role">${agent.role}</div>
        </div>
        <span class="boardroom-agent-status ${agent.online ? 'online' : 'offline'}"></span>
      `;
            this.boardroomElements.agentList.appendChild(agentItem);
        });
    }

    async selectAgent(agentId) {
        this.showLoading('Connecting to agent...');

        try {
            this.boardroomElements.agentList.querySelectorAll('.boardroom-agent-item').forEach(item => {
                item.classList.remove('active');
            });
            const selectedItem = this.boardroomElements.agentList.querySelector(`[data-agent-id="${agentId}"]`);
            if (selectedItem) {
                selectedItem.classList.add('active');
            }

            this.currentAgent = this.agents.find(a => a.agentId === agentId);

            // Load agent profile
            const profileResponse = await this._authedFetch(`${this.boardroomConfig.apiBase}/agents/${agentId}`);
            if (profileResponse.ok) {
                const profile = await profileResponse.json();
                this.renderAgentProfile(profile);
            }

            // Start a fresh conversation "thread" for the new agent.
            // conversationId is just tracked client-side now; the backend
            // /chat route is stateless per-request.
            this.conversationId = `${agentId}-${Date.now()}`;
            this._clearMessages();
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

    toggleView(view) {
        this.dispatchEvent(new CustomEvent('boardroom-view-change', {
            bubbles: true,
            detail: { view }
        }));

        if (view === 'chat') {
            this.boardroomElements.chatArea?.classList.remove('hidden');
            this.boardroomElements.profileDetail?.classList.add('hidden');
        } else if (view === 'profile') {
            this.boardroomElements.chatArea?.classList.add('hidden');
            this.boardroomElements.profileDetail?.classList.remove('hidden');
        }
    }

    filterMembers(query) {
        const lowerQuery = query.toLowerCase();
        this.boardroomElements.agentList.querySelectorAll('.boardroom-agent-item').forEach(item => {
            const name = item.querySelector('.boardroom-agent-name').textContent.toLowerCase();
            const role = item.querySelector('.boardroom-agent-role').textContent.toLowerCase();
            const matches = name.includes(lowerQuery) || role.includes(lowerQuery);
            item.style.display = matches ? '' : 'none';
        });
    }

    /**
     * Send the current input.
     *
     * TEMP (standalone chat UI testing): both the CopilotKit runtime path
     * and the backend `/chat` fallback are disabled below in favor of a
     * local echo, since neither the runtime nor the backend is wired up
     * yet. Restore the commented-out block below (and remove the stub) once
     * agent orchestration is ready.
     */
    async sendMessage() {
        // TEMP: no backend/agent wired up yet — local echo only
        const inputEl = this._getChatInputElement();
        if (!inputEl) return;

        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        this._updateCharCount(inputEl);

        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        const emptyState = messagesEl
            ? messagesEl.querySelector('.chatroom-empty-state')
            : this.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;

        this._appendUserMessage(text);

        // Fake a short "thinking" delay then echo back, so the UI feels alive
        this.showLoading('Waiting for response...');
        setTimeout(() => {
            this._appendAgentMessage(`(stub) You said: "${text}"`);
            this.hideLoading();
        }, 400);

        /* ── Restore this block once backend/CopilotKit orchestration is ready ──

        if (this.copilotKit) {
            await this._sendViaCopilotKit();
            return;
        }

        // Fallback: our own backend route (non-streaming)
        this.showLoading('Waiting for response...');

        try {
            const response = await this._authedFetch(`${this.boardroomConfig.apiBase}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    agentId: this.currentAgent?.agentId ?? null,
                    conversationId: this.conversationId ?? null,
                }),
            });

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                throw new Error(errBody.error || `Request failed (${response.status})`);
            }

            const data = await response.json();
            const replyText = data.message || data.reply || data.text || JSON.stringify(data);
            this._appendAgentMessage(replyText);
        } catch (error) {
            console.error('[Boardroom] sendMessage failed:', error);
            this.showToast('Failed to get a response — please try again', 'error');
        } finally {
            this.hideLoading();
        }

        ── end restore block ── */
    }

    /**
     * Send the current input via the CopilotKit runtime (AG-UI HTTP protocol).
     * Renders a user bubble immediately, then streams the AI response token-by-token.
     */
    async _sendViaCopilotKit() {
        const inputEl = this._getChatInputElement();
        if (!inputEl) return;

        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        this._updateCharCount(inputEl);

        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        const emptyState = messagesEl
            ? messagesEl.querySelector('.chatroom-empty-state')
            : this.querySelector('.chatroom-empty-state');
        if (emptyState) emptyState.hidden = true;

        this._appendUserMessage(text);

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

    // ── DOM helpers ──────────────────────────────────────────────────────

    /** Get the chat textarea element */
    _getChatInputElement() {
        return (
            (this.elements && this.elements.inputField) ||
            this.querySelector('.chatroom-input-field') ||
            this.querySelector('textarea[name="message"]') ||
            this.querySelector('#chat-input') ||
            this.querySelector('textarea')
        );
    }

    /** Update character-count display after clearing input */
    _updateCharCount(inputEl) {
        const counter = (this.elements && this.elements.charCount)
            || this.querySelector('.chatroom-char-count');
        if (counter) {
            counter.textContent = `0/${inputEl.maxLength > 0 ? inputEl.maxLength : (this.config.maxLength || 1000)}`;
        }
    }

    /** Clear all messages from the chat area */
    _clearMessages() {
        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (messagesEl) {
            messagesEl.replaceChildren();
            const emptyState = messagesEl.querySelector('.chatroom-empty-state');
            if (emptyState) emptyState.hidden = false;
        }
    }

    /** Append the user's own message bubble to the chat */
    _appendUserMessage(text) {
        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (!messagesEl) return;

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const article = document.createElement('article');
        article.className = 'boardroom-message-row flex-row-reverse';
        article.setAttribute('aria-label', 'Your message');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'boardroom-message-content';

        const bubble = document.createElement('div');
        bubble.className = 'boardroom-message-bubble bg-primary text-white';
        bubble.textContent = text;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'boardroom-message-meta boardroom-message-meta-sent';

        const timestamp = document.createElement('span');
        timestamp.className = 'boardroom-message-timestamp';
        timestamp.textContent = time;

        metaDiv.appendChild(timestamp);
        contentDiv.appendChild(bubble);
        contentDiv.appendChild(metaDiv);
        article.appendChild(contentDiv);
        messagesEl.appendChild(article);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /** Append a completed agent reply bubble (non-streaming) */
    _appendAgentMessage(text) {
        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (!messagesEl) return;

        const agent = this.currentAgent?.name || 'AI';
        const role = this.currentAgent?.role || 'AI Assistant';
        const avatar = this.currentAgent?.avatar || '';
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const article = document.createElement('article');
        article.className = 'boardroom-message-row';
        article.setAttribute('aria-label', `Message from ${agent}`);

        const avatarBlock = document.createElement('div');
        avatarBlock.className = 'boardroom-message-avatar-block';

        if (avatar) {
            const img = document.createElement('img');
            img.src = avatar;
            img.alt = agent;
            img.className = 'boardroom-message-avatar';
            img.width = 40;
            img.height = 40;
            avatarBlock.appendChild(img);
        }

        const avatarMeta = document.createElement('div');
        avatarMeta.className = 'boardroom-message-avatar-meta';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'boardroom-message-avatar-name';
        nameSpan.textContent = agent;
        avatarMeta.appendChild(nameSpan);
        avatarMeta.appendChild(document.createElement('br'));

        const roleSpan = document.createElement('span');
        roleSpan.className = 'boardroom-message-avatar-role';
        roleSpan.textContent = role;
        avatarMeta.appendChild(roleSpan);
        avatarBlock.appendChild(avatarMeta);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'boardroom-message-content';

        const bubble = document.createElement('div');
        bubble.className = 'boardroom-message-bubble bg-white text-dark';
        bubble.textContent = text;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'boardroom-message-meta boardroom-message-meta-received';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'boardroom-message-timestamp';
        timeSpan.textContent = time;
        metaDiv.appendChild(timeSpan);

        contentDiv.appendChild(bubble);
        contentDiv.appendChild(metaDiv);
        article.appendChild(avatarBlock);
        article.appendChild(contentDiv);
        messagesEl.appendChild(article);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * Create a new AI streaming bubble when the CopilotKit runtime starts a message.
     * @param {string} messageId - Unique ID from the runtime SSE stream
     * @param {string} [agentName] - Display name of the responding agent
     */
    _createStreamingBubble(messageId, agentName) {
        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (!messagesEl) return;

        const agent = agentName || this.currentAgent?.name || 'AI';
        const role = this.currentAgent?.role || 'AI Assistant';
        const avatar = this.currentAgent?.avatar || '';

        const article = document.createElement('article');
        article.className = 'boardroom-message-row';
        article.id = `copilotkit-msg-${messageId}`;
        article.setAttribute('aria-label', `Message from ${agent}`);

        const avatarBlock = document.createElement('div');
        avatarBlock.className = 'boardroom-message-avatar-block';

        if (avatar) {
            const img = document.createElement('img');
            img.src = avatar;
            img.alt = agent;
            img.className = 'boardroom-message-avatar';
            img.width = 40;
            img.height = 40;
            avatarBlock.appendChild(img);
        }

        const avatarMeta = document.createElement('div');
        avatarMeta.className = 'boardroom-message-avatar-meta';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'boardroom-message-avatar-name';
        nameSpan.textContent = agent;
        avatarMeta.appendChild(nameSpan);
        avatarMeta.appendChild(document.createElement('br'));

        const roleSpan = document.createElement('span');
        roleSpan.className = 'boardroom-message-avatar-role';
        roleSpan.textContent = role;
        avatarMeta.appendChild(roleSpan);
        avatarBlock.appendChild(avatarMeta);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'boardroom-message-content';

        const bubble = document.createElement('div');
        bubble.className = 'boardroom-message-bubble bg-white text-dark';
        bubble.id = `copilotkit-bubble-${messageId}`;

        const cursor = document.createElement('span');
        cursor.className = 'boardroom-streaming-cursor';
        cursor.textContent = '▍';
        bubble.appendChild(cursor);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'boardroom-message-meta boardroom-message-meta-received';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'boardroom-message-timestamp';
        timeSpan.id = `copilotkit-time-${messageId}`;
        timeSpan.textContent = '…';
        metaDiv.appendChild(timeSpan);

        contentDiv.appendChild(bubble);
        contentDiv.appendChild(metaDiv);
        article.appendChild(avatarBlock);
        article.appendChild(contentDiv);
        messagesEl.appendChild(article);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * Append a streaming text chunk to the active AI bubble.
     * @param {string} chunk - New token(s) to append
     * @param {string} messageId - ID matching the bubble created by _createStreamingBubble
     */
    _appendStreamChunk(chunk, messageId) {
        const bubble = this.querySelector(`#copilotkit-bubble-${messageId}`);
        if (!bubble) return;

        const cursor = bubble.querySelector('.boardroom-streaming-cursor');
        if (cursor) cursor.remove();

        bubble.appendChild(document.createTextNode(chunk));

        const newCursor = document.createElement('span');
        newCursor.className = 'boardroom-streaming-cursor';
        newCursor.textContent = '▍';
        bubble.appendChild(newCursor);

        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    /**
     * Finalize a streaming AI bubble once the message is complete.
     * Removes the cursor and adds the timestamp.
     * @param {string} messageId
     * @param {string} fullContent - Complete response text
     */
    _finalizeStreamingBubble(messageId, fullContent) {
        const bubble = this.querySelector(`#copilotkit-bubble-${messageId}`);
        if (bubble) {
            const cursor = bubble.querySelector('.boardroom-streaming-cursor');
            if (cursor) cursor.remove();

            if (bubble.textContent.trim() !== fullContent.trim()) {
                bubble.textContent = '';
                bubble.appendChild(document.createTextNode(fullContent));
            }
        }

        const timeEl = this.querySelector(`#copilotkit-time-${messageId}`);
        if (timeEl) {
            timeEl.textContent = new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
            });
        }

        const messagesEl = (this.elements && this.elements.messagesContainer)
            || this.querySelector('.chatroom-messages');
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    // Boardroom-specific features
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
        // Belt-and-suspenders: some deployments' CSS shows this overlay by
        // default (display:flex) with no rule that hides it in the absence
        // of .active, so force it closed directly too.
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

// Register the custom element if not already defined to avoid duplicate-define errors
if (!customElements.get('boardroom-app')) {
    customElements.define('boardroom-app', BoardroomApp);
}

export default BoardroomApp;
