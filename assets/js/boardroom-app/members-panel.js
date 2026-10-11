/**
 * The members sidebar: board roster, member selection, the speaking
 * member, and the agent profile. Populates the static mount point
 * (#chatroomMembersList); chatroom-panels.js owns show/hide and filtering.
 */

import {
    BOARDROOM_ROSTER,
} from './constants.js';

export class MembersPanel {
    /** @param {HTMLElement} app - The BoardroomApp host element. */
    constructor(app) {
        this.app = app;
        this.activeSpeaker = null;
    }

    speakerInfo(name) {
        const key = String(name || '').toLowerCase();
        return this.app.agents.find((a) => a.agentId === key || (a.name || '').toLowerCase() === key) || null;
    }

    /** Mark the deliberating C-suite member in the members sidebar. */
    setActiveSpeaker(speaker) {
        const key = String(speaker || '').toLowerCase();
        // Presence is keyed on roster role ids only (07).
        this.activeSpeaker = key && BOARDROOM_ROSTER.some((a) => a.agentId === key) ? key : null;
        const list = this.app.boardroomElements?.membersList;
        if (!list) return;
        list.querySelectorAll('.chatroom-members-sidebar__item').forEach((item) => {
            const active = !!this.activeSpeaker && item.dataset.agentId === this.activeSpeaker;
            item.classList.toggle('chatroom-members-sidebar__item--speaking', active);
            if (active) item.setAttribute('aria-current', 'true');
            else item.removeAttribute('aria-current');
        });
    }

    async load() {
        if (this.app.copilotKit) {
            // The AG-UI backend has no roster endpoint; every member is
            // 'online' as part of the perpetual boardroom.
            this.app.agents = BOARDROOM_ROSTER.map((a) => ({
                ...a,
                online: true,
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(a.name)}&background=random&size=64`,
            }));
            this.render();
            return;
        }
        try {
            const response = await this.app.msalAuth.authedFetch(`${this.app.boardroomConfig.apiBase}/agents`);
            if (response.ok) {
                this.app.agents = await response.json();
                this.render();
            }
        } catch (error) {
            console.error('Error loading agents:', error);
            this.app.showToast('Failed to load agents', 'error');
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
    render() {
        if (!this.app.boardroomElements.membersList) return;

        this.app.boardroomElements.membersList.replaceChildren();

        this.app.agents.forEach((agent) => {
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

            this.app.boardroomElements.membersList.appendChild(item);
        });

        if (this.app.boardroomElements.membersCount) {
            const onlineCount = this.app.agents.filter((a) => a.online).length;
            this.app.boardroomElements.membersCount.textContent = `${onlineCount} online`;
        }
    }

    async select(agentId) {
        // Selecting a member focuses/highlights them; in AG-UI mode the
        // whole board stays in one shared thread (no per-agent routing).
        this.app.boardroomElements.membersList.querySelectorAll('.chatroom-members-sidebar__item').forEach((item) => {
            item.classList.remove('chatroom-members-sidebar__item--active');
        });
        const selectedItem = this.app.boardroomElements.membersList.querySelector(`[data-agent-id="${agentId}"]`);
        if (selectedItem) {
            selectedItem.classList.add('chatroom-members-sidebar__item--active');
        }
        this.app.currentAgent = this.app.agents.find((a) => a.agentId === agentId) || null;

        if (this.app.copilotKit) {
            this.app.dispatchEvent(new CustomEvent('boardroom-agent-selected', {
                bubbles: true,
                detail: { agent: this.app.currentAgent, conversationId: this.app.conversationId },
            }));
            return;
        }

        this.app.showLoading('Connecting to agent...');
        try {
            const profileResponse = await this.app.msalAuth.authedFetch(`${this.app.boardroomConfig.apiBase}/agents/${agentId}`);
            if (profileResponse.ok) {
                const profile = await profileResponse.json();
                this.renderProfile(profile);
            }

            // conversationId is tracked client-side; the backend /chat
            // route is stateless per-request.
            this.app.conversationId = `${agentId}-${Date.now()}`;
            this.app.clearMessages();
            this.app.updateTitle(this.app.currentAgent?.name ?? agentId);

            this.app.hideLoading();

            this.app.dispatchEvent(new CustomEvent('boardroom-agent-selected', {
                bubbles: true,
                detail: { agent: this.app.currentAgent, conversationId: this.app.conversationId }
            }));
        } catch (error) {
            console.error('Error selecting agent:', error);
            this.app.showToast('Failed to connect to agent', 'error');
            this.app.hideLoading();
        }
    }

    renderProfile(profile) {
        if (!this.app.boardroomElements.profileDetail) return;

        this.app.boardroomElements.profileDetail.innerHTML = `
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
}

export default MembersPanel;
