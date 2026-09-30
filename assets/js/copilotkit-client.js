/**
 * CopilotKit Client for Boardroom
 *
 * Connects the boardroom chatroom to a server-side CopilotKit runtime
 * using the AG-UI HTTP protocol (@copilotkit/sdk-js compatible).
 *
 * Protocol: POST JSON → Accept: text/event-stream SSE response
 * Events follow the AG-UI standard (TextMessageStart/Content/End, ToolCallStart/Args/End,
 * RunStarted, RunFinished, RunError, StateSnapshot, StateDelta).
 */

export class CopilotKitClient {
  /**
   * @param {object} options
   * @param {string} options.runtimeUrl    - URL of the CopilotKit runtime endpoint
   * @param {string} [options.threadId]    - Existing thread ID for conversation continuity
   * @param {string} [options.agentName]   - Default agent name to route messages to
   * @param {object} [options.headers]     - Extra HTTP headers (e.g. Authorization)
   * @param {number} [options.maxHistory]  - Maximum messages to retain in history (default: 50)
   * @param {() => Promise<string|null>} [options.getAccessToken] - Async function
   *   returning a Bearer token to attach to each request, called fresh before
   *   every sendMessage(). Lets the caller manage token acquisition/refresh
   *   (e.g. via MSAL silent renewal) rather than this client owning any
   *   particular auth mechanism. If omitted, no Authorization header is sent.
   */
  constructor(options = {}) {
    this.runtimeUrl = options.runtimeUrl || '/api/copilotkit';
    this.threadId = options.threadId || CopilotKitClient.randomUUID();
    this.agentName = options.agentName || null;
    this.extraHeaders = options.headers || {};
    this.maxHistory = options.maxHistory ?? 50;
    this.getAccessToken = options.getAccessToken || null;
    this.messages = [];
    this.abortController = null;

    // Callbacks
    this.onStreamChunk = null;   // (chunk, messageId) => void
    this.onMessageStart = null;  // (messageId, agentName?) => void
    this.onMessageEnd = null;    // (messageId, fullContent) => void
    this.onRunFinished = null;   // (finalContent) => void
    this.onError = null;         // (error) => void
  }

  // ── UUID helper ──────────────────────────────────────────────────────────

  static randomUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Thread management ────────────────────────────────────────────────────

  /** Start a fresh conversation thread */
  resetThread() {
    this.threadId = CopilotKitClient.randomUUID();
    this.messages = [];
  }

  /** Set (or clear) the active agent for subsequent messages */
  setAgent(agentName) {
    this.agentName = agentName || null;
  }

  /** Return a copy of the current message history (for debugging / state inspection) */
  getMessages() {
    return [...this.messages];
  }

  // ── Message history ──────────────────────────────────────────────────────

  _addMessage(role, content) {
    this.messages.push({
      id: CopilotKitClient.randomUUID(),
      role,
      content,
    });
    // Trim history to stay within the configured maximum
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }
  }

  // ── Core send ────────────────────────────────────────────────────────────

  /**
   * Send a user message to the CopilotKit runtime and stream the response.
   *
   * @param {string} userMessage - The user's text input
   * @param {object} [options]   - Additional options (context, headers, etc.)
   * @returns {Promise<string>}  - Full AI response text
   */
  async sendMessage(userMessage, options = {}) {
    this._addMessage('user', userMessage);

    // Abort any in-flight request
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const requestBody = {
      threadId: this.threadId,
      runId: CopilotKitClient.randomUUID(),
      messages: this.messages,
      state: {},
      // AG-UI RunAgentInput requires `tools`, `context` (each {description, value})
      // and `forwardedProps`; omitting them yields a 422 from the backend.
      tools: options.tools || [],
      context: (options.context || []).map((c) => ({
        description: c.description ?? '',
        value: typeof c.value === 'string' ? c.value : JSON.stringify(c.value ?? c.description ?? ''),
      })),
      forwardedProps: {
        ...(this.agentName ? { agentName: this.agentName } : {}),
        ...options.forwardedProps,
      },
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...this.extraHeaders,
      ...options.headers,
    };

    // Acquire the Bearer token via the caller-supplied getAccessToken
    // callback (e.g. MSAL silent token acquisition), if one was provided.
    if (this.getAccessToken) {
      try {
        const token = await this.getAccessToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch (err) {
        console.error('[CopilotKit] getAccessToken() failed:', err);
      }
    }

    try {
      const response = await fetch(this.runtimeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`CopilotKit runtime error ${response.status}: ${errText}`);
      }

      const fullContent = await this._processSSEStream(response);

      if (fullContent) {
        this._addMessage('assistant', fullContent);
      }

      return fullContent;
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (this.onError) {
          this.onError(error);
        }
      }
      throw error;
    }
  }

  /** Abort any in-progress stream */
  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ── SSE stream processing ────────────────────────────────────────────────

  async _processSSEStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const messageBuffer = {};
    let fullContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on newlines; keep incomplete last chunk
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const event = JSON.parse(dataStr);
            const chunk = this._processEvent(event, messageBuffer);
            if (chunk) {
              fullContent += chunk;
            }
          } catch (parseError) {
            // Malformed JSON – log at debug level and skip
            console.debug('[CopilotKit] Skipping unparseable SSE data:', dataStr, parseError);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (this.onRunFinished) {
      this.onRunFinished(fullContent);
    }
    return fullContent;
  }

  /**
   * Handle a single AG-UI / legacy-CopilotKit SSE event.
   * Supports both camelCase legacy names and SCREAMING_SNAKE AG-UI names.
   *
   * @param {object} event         - Parsed JSON event
   * @param {object} messageBuffer - Accumulation buffer keyed by messageId
   * @returns {string|null}        - Streamed text chunk, if any
   */
  _processEvent(event, messageBuffer) {
    const { type } = event;

    switch (type) {
      // ── Message start ──
      case 'TEXT_MESSAGE_START':
      case 'TextMessageStart': {
        messageBuffer[event.messageId] = '';
        if (this.onMessageStart) {
          this.onMessageStart(event.messageId, event.agentName);
        }
        return null;
      }

      // ── Streaming content ──
      case 'TEXT_MESSAGE_CONTENT':
      case 'TextMessageContent': {
        // AG-UI uses `delta`; legacy CopilotKit used `content`
        const chunk = event.delta ?? event.content ?? '';
        messageBuffer[event.messageId] = (messageBuffer[event.messageId] ?? '') + chunk;
        if (this.onStreamChunk) {
          this.onStreamChunk(chunk, event.messageId);
        }
        return chunk;
      }

      // ── Message end ──
      case 'TEXT_MESSAGE_END':
      case 'TextMessageEnd': {
        const full = messageBuffer[event.messageId] ?? '';
        if (this.onMessageEnd) {
          this.onMessageEnd(event.messageId, full);
        }
        delete messageBuffer[event.messageId];
        return null;
      }

      // ── Run lifecycle ──
      case 'RUN_STARTED':
      case 'RunStarted':
        return null;

      case 'RUN_FINISHED':
      case 'RunFinished': {
        const combined = Object.values(messageBuffer).join('');
        if (this.onRunFinished) {
          this.onRunFinished(combined);
        }
        return null;
      }

      case 'RUN_ERROR':
      case 'RunError': {
        const err = new Error(event.message ?? 'CopilotKit run error');
        if (this.onError) {
          this.onError(err);
        }
        return null;
      }

      // ── Agent state ──
      case 'AGENT_STATE_MESSAGE':
      case 'AgentStateMessage':
        return null;

      // ── Tool calls (no text output on the client side) ──
      case 'TOOL_CALL_START':
      case 'ActionExecutionStart':
      case 'TOOL_CALL_ARGS':
      case 'ActionExecutionArgs':
      case 'TOOL_CALL_END':
      case 'ActionExecutionEnd':
      case 'TOOL_CALL_RESULT':
      case 'ActionExecutionResult':
        return null;

      // ── State updates ──
      case 'STATE_SNAPSHOT':
      case 'STATE_DELTA':
      case 'MESSAGES_SNAPSHOT':
      case 'STEP_STARTED':
      case 'STEP_FINISHED':
        return null;

      default:
        return null;
    }
  }
}

export default CopilotKitClient;
