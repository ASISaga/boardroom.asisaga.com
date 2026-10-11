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
 * see AguiSession.init() and sendMessage() below. The backend is a Python
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
 * MsalAuth.redirectToLogin()). MSAL_CONFIG and MSAL_API_SCOPES in
 * boardroom-app/msal-auth.js must match the app's Entra app registration.
 * Any in-progress draft message is preserved across the redirect
 * round-trip via sessionStorage (see MsalAuth.redirectToLogin() /
 * MsalAuth.restoreDraftMessage()). Acquired access tokens
 * are attached as a Bearer token on every API request via MsalAuth.authedFetch(),
 * which tries silent renewal first and falls back to a fresh interactive
 * redirect only when needed.
 *
 * BoardroomApp itself is the ChatroomApp subclass: lifecycle, ChatroomApp
 * hooks and the public API. The behaviour lives in collaborator classes
 * under assets/js/boardroom-app/, each holding a reference to this element:
 * - MsalAuth (msal-auth.js): Entra sign-in, tokens, authed fetch
 * - AuthChecklist (auth-checklist.js): sign-in checklist UI, admin consent
 * - AuthGate (auth-gate.js): /auth/status, capabilities, 401/403 handling
 * - AguiSession (agui-session.js): CopilotKitClient wiring, hydrate, send
 * - RunStatus (run-status.js): busy, deliberating, interjection, live-only
 * - MessageView (message-view.js): streamed bubbles, speaker relay panel
 * - MembersPanel (members-panel.js): roster, selection, speaking member
 * - ChatLog (chat-log.js): system notes, log level, protocol event log
 * - BoardroomChrome (boardroom-chrome.js): header/toolbar buttons, files
 */

import ChatroomApp from '/assets/js/chatroom-app.js';
import { MsalAuth } from './boardroom-app/msal-auth.js';
import { ChatLog } from './boardroom-app/chat-log.js';
import { AuthChecklist } from './boardroom-app/auth-checklist.js';
import { AuthGate } from './boardroom-app/auth-gate.js';
import { RunStatus } from './boardroom-app/run-status.js';
import { MessageView } from './boardroom-app/message-view.js';
import { MembersPanel } from './boardroom-app/members-panel.js';
import { BoardroomChrome } from './boardroom-app/boardroom-chrome.js';
import { AguiSession } from './boardroom-app/agui-session.js';

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

        // CopilotKitClient, created by AguiSession.init() when
        // copilotkit-runtime-url is set.
        this.copilotKit = null;

        // Last GET /auth/status body (display/diagnostics only: tenant_id and
        // company_id are never sent back to the backend, INV-5) and the
        // capabilities it grants. Admin controls stay hidden until
        // `administer` is true.
        this.authStatus = null;
        this.capabilities = { participate: false, administer: false };

        // Collaborators (assets/js/boardroom-app/). MsalAuth holds the MSAL
        // PublicClientApplication and signed-in account, set up in
        // MsalAuth.init() (called from connectedCallback, since MSAL needs
        // to process any redirect response before anything else runs).
        this.msalAuth = new MsalAuth(this);
        this.chatLog = new ChatLog(this);
        this.authChecklist = new AuthChecklist(this);
        this.authGate = new AuthGate(this);
        this.runStatus = new RunStatus(this);
        this.messageView = new MessageView(this);
        this.membersPanel = new MembersPanel(this);
        this.boardroomChrome = new BoardroomChrome(this);
        this.aguiSession = new AguiSession(this);
    }

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
            this.boardroomChrome.addFormattingButtons(inputEl);
        }
        if (this.boardroomConfig.enableFileAttach) {
            this.boardroomChrome.addFileAttachButton(inputEl);
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
        this.boardroomChrome.addHeaderActions(rootEl);
    }

    async connectedCallback() {
        // Runs the inherited hydration, which calls our _onLayoutBuilt /
        // _onInputBuilt hooks above against the already-static shell.
        await super.connectedCallback();
        this.chatLog.buildControl();

        // Hide the initial loading overlay now that hydration has run —
        // it's no longer tied to a live connection at this stage. Without this,
        // the overlay stays visible indefinitely since hideLoading() otherwise
        // only fires after a successful agent selection.
        this.hideLoading();

        // Returning from Entra's admin-consent page: record and report the
        // outcome, and drop its query parameters from the address bar.
        this.authChecklist.handleAdminConsentReturn();

        // Process any pending MSAL redirect response (or pick up an
        // existing cached session) before deciding whether to require
        // sign-in. Runs after super.connectedCallback() so hydration has
        // already populated this.elements.inputField, which
        // MsalAuth.restoreDraftMessage() (called from within MsalAuth.init()) needs.
        await this.msalAuth.init();

        if (!this.msalAuth.isAuthenticated()) {
            // Navigates the whole tab away to Entra's login page; nothing
            // after this line runs on this page load.
            await this.msalAuth.redirectToLogin();
            return;
        }

        await this.initializeBoardroom();

        this.dispatchEvent(new CustomEvent('boardroom-ready', {
            bubbles: true,
            detail: { config: { ...this.config, ...this.boardroomConfig } }
        }));
    }

    async initializeBoardroom() {
        this.aguiSession.init();
        this.authGate.applyCapabilities(null);

        if (this.boardroomConfig.showAgentProfiles) {
            await this.membersPanel.load();
        }

        this.boardroomChrome.attachHandlers();

        await this.aguiSession.start();
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

    // Public API kept for page scripts; see MembersPanel / BoardroomChrome.

    attachBoardroomEventHandlers() {
        this.boardroomChrome.attachHandlers();
    }

    async loadAgents() {
        await this.membersPanel.load();
    }

    renderAgents() {
        this.membersPanel.render();
    }

    async selectAgent(agentId) {
        await this.membersPanel.select(agentId);
    }

    renderAgentProfile(profile) {
        this.membersPanel.renderProfile(profile);
    }

    async startScreenShare() {
        await this.boardroomChrome.startScreenShare();
    }

    async startVideoCall() {
        await this.boardroomChrome.startVideoCall();
    }

    async attachFile() {
        await this.boardroomChrome.attachFile();
    }

    async uploadFile(file) {
        await this.boardroomChrome.uploadFile(file);
    }

    /**
     * Send the current input.
     *
     * Routes through CopilotKit (AG-UI protocol) when configured — i.e.
     * when copilotkit-runtime-url was set, so this.copilotKit exists (see
     * AguiSession.init()). Otherwise falls back to the inherited
     * ChatroomApp.sendMessage(), which handles slash-commands/MCP apps and
     * posting to config.apiEndpoint (or a local echo when no apiEndpoint
     * is set) using the inherited chatroom__* message rendering into the
     * static .chatroom-messages container.
     */
    async sendMessage() {
        if (this.copilotKit) {
            await this.aguiSession.send();
            return;
        }

        await super.sendMessage();
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
        if (this.aguiSession.onVisibility) {
            document.removeEventListener('visibilitychange', this.aguiSession.onVisibility);
        }
        if (this.aguiSession.onPageHide) {
            window.removeEventListener('pagehide', this.aguiSession.onPageHide);
            this.aguiSession.onPageHide = null;
        }
        this.runStatus.clearInterjection();
        super.disconnectedCallback();
        this.dispatchEvent(new CustomEvent('boardroom-disconnected', { bubbles: true }));
    }
}

if (!customElements.get('boardroom-app')) {
    customElements.define('boardroom-app', BoardroomApp);
}

export default BoardroomApp;
