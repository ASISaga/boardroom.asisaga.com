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
 * the chatroom layout (_includes/layouts/chatroom/toggle-strip.html and
 * members-sidebar.html) and their show/hide + search/filter behavior is
 * owned entirely by chatroom-panels.js. BoardroomApp's only responsibility
 * toward these panels is populating the members list's mount point
 * (#chatroomMembersList) with agent data, per the data contract:
 *   <li class="chatroom-members-sidebar__item"
 *       data-status="online|away|offline"
 *       data-name="lowercase searchable name">
 *
 * Chat messages are routed through the AG-UI protocol via CopilotKitClient
 * (copilotkit-client.js) whenever copilotkit-runtime-url is configured —
 * see _initCopilotKit() and sendMessage() below. The backend is a Python
 * agent-framework service exposed via add_agent_framework_fastapi_endpoint
 * (agent_framework.ag_ui), which speaks the standard AG-UI SSE event
 * protocol; CopilotKitClient's dual-format event handling
 * (TEXT_MESSAGE_START / TextMessageStart, etc.) already matches this
 * protocol-level contract, not a CopilotKit-specific one. When no
 * copilotkit-runtime-url is set, sendMessage() falls back to the inherited
 * ChatroomApp.sendMessage() (REST api-endpoint, or local echo if unset).
 *
 * Authentication is via Microsoft Entra ID, using MSAL.js
 * (@azure/msal-browser, loaded as a CDN UMD global — see
 * _includes/msal-library.html) with a full-tab loginRedirect() flow (see
 * _redirectToLogin()). MSAL_CONFIG and MSAL_API_SCOPES below currently
 * hold PLACEHOLDER values — the tenant ID, client ID, redirect URI, and
 * API scope must be filled in from the app's Entra app registration
 * before this is deployed. Any in-progress draft message is preserved
 * across the redirect round-trip via sessionStorage (see
 * _redirectToLogin() / _restoreDraftMessage()). Acquired access tokens
 * are attached as a Bearer token on every API request via _authedFetch(),
 * which tries silent renewal first and falls back to a fresh interactive
 * redirect only when needed.
 */

import ChatroomApp from '/assets/js/chatroom-app.js';
import { CopilotKitClient } from '/assets/js/copilotkit-client.js';

// ============================================================================
// MSAL / Entra configuration
// ============================================================================
// PLACEHOLDER VALUES — replace all three before deploying. See Azure Portal →
// Microsoft Entra ID → App registrations → (this app) → Overview (for
// clientId / tenantId) and → Authentication (for the registered redirect
// URI, which must match exactly).
//
// apiScope is the scope requested when acquiring a token for the backend
// API specifically (as opposed to a login-only ID token) — typically
// "api://<backend-app-client-id>/<scope-name>", e.g.
// "api://00000000-0000-0000-0000-000000000000/access_as_user". Confirm the
// exact value with whoever owns the backend's app registration ("Expose an
// API" blade) — using the wrong scope produces a token the backend will
// reject even though login itself succeeds.
const MSAL_CONFIG = {
    auth: {
        clientId: '09ee9579-46c7-4163-949c-f5f90067a70c',
        authority: 'https://login.microsoftonline.com/d1c9a3d1-9701-4605-b5aa-fef9728b0331',
        redirectUri: 'https://boardroom.asisaga.com/boardroom/'
    },
    cache: {
        // localStorage (not the MSAL default sessionStorage) so the session
        // survives the full-tab redirect round-trip and persists across
        // browser tabs/restarts, consistent with how boardroom previously
        // persisted its auth token.
        cacheLocation: 'localStorage',
    },
};

const MSAL_API_SCOPES = ['api://09ee9579-46c7-4163-949c-f5f90067a70c/access_as_user']; // e.g. 'api://<backend-client-id>/access_as_user'

// sessionStorage key used to stash an in-progress draft message across the
// full-tab redirect round-trip (see Option B: full-tab redirect, restore
// visual state after). Cleared once restored.
const DRAFT_STORAGE_KEY = 'boardroom_draft_message';

class BoardroomApp extends ChatroomApp {
    constructor() {
        super();

        this.boardroomConfig = {
            showToggleStrip: this.hasAttribute('show-toggle-strip'),
            showMembersSidebar: this.hasAttribute('show-members-sidebar'),
            showAgentProfiles: this.hasAttribute('show-agent-profiles'),
            apiBase: this.getAttribute('api-base') || '/api/boardroom',
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

        // MSAL PublicClientApplication instance and the signed-in account,
        // set up in _initMsal() (called from connectedCallback, since MSAL
        // needs to process any redirect response before anything else runs).
        this.msalClient = null;
        this.msalAccount = null;
    }

    // ── Auth: Entra / MSAL ───────────────────────────────────────────────

    /**
     * Construct the MSAL client and process any pending redirect response
     * (i.e. the user has just been sent back here after loginRedirect()).
     * Must be called and awaited before any other MSAL API is used — MSAL
     * requires handleRedirectPromise() to resolve first, even if there is
     * no redirect in progress (it resolves to null in that case).
     *
     * Restores any draft message text that was stashed in sessionStorage
     * before the redirect (see _redirectToLogin()).
     */
    async _initMsal() {
        if (typeof msal === 'undefined') {
            console.error('[Boardroom] MSAL library not loaded — check that msal-library.html is included before this module.');
            return;
        }

        this.msalClient = new msal.PublicClientApplication(MSAL_CONFIG);
        await this.msalClient.initialize();

        let redirectResult = null;
        try {
            redirectResult = await this.msalClient.handleRedirectPromise();
        } catch (err) {
            console.error('[Boardroom] MSAL redirect handling failed:', err);
        }

        if (redirectResult?.account) {
            this.msalAccount = redirectResult.account;
        } else {
            // Not returning from a redirect — check for an existing cached
            // session (e.g. a previous tab already signed in).
            const accounts = this.msalClient.getAllAccounts();
            if (accounts.length > 0) {
                this.msalAccount = accounts[0];
            }
        }

        this._restoreDraftMessage();
    }

    _isAuthenticated() {
        return !!this.msalAccount;
    }

    /**
     * Save the current input field's draft text to sessionStorage, then
     * navigate the full tab to Entra's login page via loginRedirect(). The
     * page fully reloads on return; _initMsal() (called again on that
     * fresh load) picks up the redirect result and _restoreDraftMessage()
     * puts the draft text back.
     * @returns {Promise<never>} Never resolves — the page navigates away.
     */
    async _redirectToLogin() {
        try {
            const draft = this.elements?.inputField?.value;
            if (draft) sessionStorage.setItem(DRAFT_STORAGE_KEY, draft);
        } catch (err) {
            console.warn('[Boardroom] Could not persist draft message before redirect:', err);
        }

        await this.msalClient.loginRedirect({ scopes: MSAL_API_SCOPES });
        // loginRedirect() navigates away; execution does not continue past
        // this point on success.
    }

    /**
     * Restore a draft message stashed before a login redirect, if any.
     * Called once from _initMsal(), after the static input field exists
     * (hydration has already run by the time connectedCallback calls this).
     */
    _restoreDraftMessage() {
        let draft = null;
        try {
            draft = sessionStorage.getItem(DRAFT_STORAGE_KEY);
            if (draft) sessionStorage.removeItem(DRAFT_STORAGE_KEY);
        } catch (err) {
            console.warn('[Boardroom] Could not read persisted draft message:', err);
            return;
        }
        if (draft && this.elements?.inputField) {
            this.elements.inputField.value = draft;
        }
    }

    /**
     * Acquire an access token for the backend API, silently if possible.
     * Falls back to a full-tab redirect (_redirectToLogin) when silent
     * acquisition fails — e.g. no cached session, or the session has
     * expired and needs fresh interactive sign-in.
     * @returns {Promise<string|null>} The access token, or null if a
     *   redirect was triggered (in which case the page is navigating away).
     */
    async _acquireToken() {
        if (!this.msalAccount) {
            await this._redirectToLogin();
            return null;
        }

        try {
            const result = await this.msalClient.acquireTokenSilent({
                scopes: MSAL_API_SCOPES,
                account: this.msalAccount,
            });
            return result.accessToken;
        } catch (err) {
            // InteractionRequiredAuthError and similar — silent acquisition
            // failed, fall back to interactive redirect.
            console.warn('[Boardroom] Silent token acquisition failed, redirecting to login:', err);
            await this._redirectToLogin();
            return null;
        }
    }

    async _authedFetch(url, options = {}) {
        const token = await this._acquireToken();
        if (!token) {
            // _acquireToken() triggered a redirect; the page is navigating
            // away, so this request will never complete. Return a
            // never-resolving promise-like rejection is unnecessary since
            // the page unload will abort everything shortly — just reject
            // cleanly for any caller that might race the navigation.
            throw new Error('Redirecting to login — request aborted.');
        }

        const doFetch = (accessToken) => fetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                Authorization: `Bearer ${accessToken}`,
            },
        });

        let response = await doFetch(token);

        if (response.status === 401) {
            // Token was rejected despite MSAL considering it valid (e.g.
            // revoked server-side) — force a fresh interactive login rather
            // than retrying with the same stale token.
            this.msalAccount = null;
            await this._redirectToLogin();
            throw new Error('Redirecting to login — request aborted.');
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

        // Process any pending MSAL redirect response (or pick up an
        // existing cached session) before deciding whether to require
        // sign-in. Runs after super.connectedCallback() so hydration has
        // already populated this.elements.inputField, which
        // _restoreDraftMessage() (called from within _initMsal()) needs.
        await this._initMsal();

        if (!this._isAuthenticated()) {
            // Navigates the whole tab away to Entra's login page; nothing
            // after this line runs on this page load.
            await this._redirectToLogin();
            return;
        }

        await this.initializeBoardroom();

        this.dispatchEvent(new CustomEvent('boardroom-ready', {
            bubbles: true,
            detail: { config: { ...this.config, ...this.boardroomConfig } }
        }));
    }

    async initializeBoardroom() {
        this._initCopilotKit();

        if (this.boardroomConfig.showAgentProfiles) {
            await this.loadAgents();
        }

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

        this.copilotKit = new CopilotKitClient({
            runtimeUrl,
            // _acquireToken() tries silent MSAL renewal first and only
            // falls back to an interactive redirect if that fails — see
            // its definition above for the full behavior.
            getAccessToken: () => this._acquireToken(),
        });

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
            this._setRunning(false);
        };
        this.copilotKit.onRunStarted = () => this._setRunning(true);
        this.copilotKit.onRunFinished = () => this._setRunning(false);
        this.copilotKit.onStateChange = (state) => {
            this.dispatchEvent(new CustomEvent('boardroom-agent-state', {
                bubbles: true,
                detail: { state, agent: this.currentAgent, conversationId: this.conversationId },
            }));
        };
        this.copilotKit.onToolCall = (call) => {
            if (call.status === 'running') {
                this.showToast(`${this.currentAgent?.name || 'Agent'}: ${call.name || 'working'}…`, 'info');
            }
            this.dispatchEvent(new CustomEvent('boardroom-tool-call', {
                bubbles: true,
                detail: { call, agent: this.currentAgent, conversationId: this.conversationId },
            }));
        };
        this._syncCopilotKitAgent();
    }

    /** Disable/enable the input while an AG-UI run is streaming. */
    _setRunning(running) {
        this.classList.toggle('boardroom-app--running', running);
        const input = this.elements?.inputField;
        if (input) input.setAttribute('aria-busy', String(running));
    }

    /**
     * Bind the AG-UI thread/agent/state to the selected boardroom agent so
     * the backend routes to the right executive and keeps per-agent context.
     */
    _syncCopilotKitAgent() {
        if (!this.copilotKit) return;
        const agent = this.currentAgent;
        this.copilotKit.setThread(this.conversationId);
        this.copilotKit.setAgent(agent ? (agent.agentId) : null);
        this.copilotKit.setState({
            boardroom: agent ? {
                agentId: agent.agentId,
                agentName: agent.name,
                role: agent.role || null,
                conversationId: this.conversationId,
            } : {},
        });
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
            this._syncCopilotKitAgent();
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
     * Routes through CopilotKit (AG-UI protocol) when configured — i.e.
     * when copilotkit-runtime-url was set, so this.copilotKit exists (see
     * _initCopilotKit()). Otherwise falls back to the inherited
     * ChatroomApp.sendMessage(), which handles slash-commands/MCP apps and
     * posting to config.apiEndpoint (or a local echo when no apiEndpoint
     * is set) using the inherited chatroom__* message rendering into the
     * static .chatroom-messages container.
     */
    async sendMessage() {
        if (this.copilotKit) {
            await this._sendViaCopilotKit();
            return;
        }

        await super.sendMessage();
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
                forwardedProps: this.currentAgent ? {
                    agentId: this.currentAgent.agentId,
                    role: this.currentAgent.role || null,
                    conversationId: this.conversationId,
                } : {},
                context: this.currentAgent
                    ? [{
                        description: 'Active boardroom agent',
                        value: `${this.currentAgent.name} (${this.currentAgent.role || 'C-suite Executive'})`,
                    }]
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
