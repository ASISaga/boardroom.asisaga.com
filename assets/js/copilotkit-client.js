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
    this.runtimeUrl = options.runtimeUrl || '/ag-ui';
    this.threadId = options.threadId || CopilotKitClient.randomUUID();
    this.agentName = options.agentName || null;
    this.extraHeaders = options.headers || {};
    this.maxHistory = options.maxHistory ?? 50;
    this.getAccessToken = options.getAccessToken || null;
    this.messages = [];
    this.abortController = null;

    // Shared agent state (AG-UI STATE_SNAPSHOT / STATE_DELTA), round-tripped
    // to the backend in each RunAgentInput.state.
    this.state = options.state || {};
    this._toolCalls = {};
    this._runFinishedFired = false;
    this._currentStep = null;    // active speaker (STEP_STARTED.stepName)

    // Callbacks
    this.onStepStarted = null;   // (speaker) => void
    this.onStepFinished = null;  // (speaker) => void
    this.onCustomEvent = null;   // (name, value) => void
    this.onRunResult = null;     // (result) => void  (RUN_FINISHED.result / digest)
    this.onRunStarted = null;    // (runId, threadId) => void
    this.onStateChange = null;   // (state) => void
    this.onToolCall = null;      // ({id, name, args, status, result}) => void
    this.onMessagesSnapshot = null; // (messages) => void
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
    this.state = {};
    this._toolCalls = {};
  }

  /** Continue an existing thread (e.g. the boardroom conversation id) */
  setThread(threadId) {
    this.threadId = threadId || CopilotKitClient.randomUUID();
    this.messages = [];
    this.state = {};
    this._toolCalls = {};
  }

  /** Merge boardroom-level state that is sent with every run */
  setState(patch) {
    this.state = { ...this.state, ...patch };
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
    this._runFinishedFired = false;

    const requestBody = {
      threadId: this.threadId,
      runId: CopilotKitClient.randomUUID(),
      // The backend relays only the latest user utterance to the boardroom
      // (it discards assistant/tool history and rejects tool calls), and
      // durable history lives server-side in mind. Send just the new turn.
      messages: [this.messages[this.messages.length - 1]],
      state: { ...this.state, ...options.state },
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
        const err = new Error(`Boardroom error ${response.status}: ${errText}`);
        err.status = response.status;
        throw err;
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

  /**
   * Hydrate the thread from the backend (known threadId, empty messages,
   * no O invocation). The server answers from mind with the last turns as
   * a MESSAGES_SNAPSHOT and a STATE_SNAPSHOT.
   *
   * @returns {Promise<void>}
   */
  async hydrate(options = {}) {
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();
    this._runFinishedFired = false;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...this.extraHeaders,
    };
    if (this.getAccessToken) {
      const token = await this.getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(this.runtimeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: this.threadId,
        runId: CopilotKitClient.randomUUID(),
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: options.forwardedProps || {},
      }),
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      const err = new Error(`Boardroom hydrate error ${response.status}`);
      err.status = response.status;
      throw err;
    }
    await this._processSSEStream(response);
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
        const lines = buffer.split(/\r?\n/);
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

    this._fireRunFinished(fullContent);
    return fullContent;
  }

  _fireRunFinished(content) {
    if (this._runFinishedFired) return;
    this._runFinishedFired = true;
    if (this.onRunFinished) this.onRunFinished(content);
  }

  _emitToolCall(id) {
    if (this.onToolCall && this._toolCalls[id]) {
      this.onToolCall({ ...this._toolCalls[id] });
    }
  }

  /** Apply an RFC 6902 JSON Patch (add/replace/remove) to this.state */
  _applyStateDelta(ops) {
    const next = JSON.parse(JSON.stringify(this.state || {}));
    for (const op of Array.isArray(ops) ? ops : []) {
      const path = String(op.path || '').split('/').slice(1)
        .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (!path.length || path.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) continue;
      let target = next;
      for (let i = 0; i < path.length - 1 && target != null; i++) target = target[path[i]];
      if (target == null || typeof target !== 'object') continue;
      const key = path[path.length - 1];
      const isArr = Array.isArray(target);
      const idx = isArr ? (key === '-' ? target.length : Number(key)) : key;
      if (op.op === 'add') {
        if (isArr) target.splice(idx, 0, op.value); else target[idx] = op.value;
      } else if (op.op === 'replace') {
        target[idx] = op.value;
      } else if (op.op === 'remove') {
        if (isArr) target.splice(idx, 1); else delete target[idx];
      }
    }
    return next;
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
          this.onMessageStart(event.messageId, event.agentName ?? this._currentStep);
        }
        return null;
      }

      // ── Streaming content ──
      case 'TEXT_MESSAGE_CONTENT':
      case 'TextMessageContent': {
        // AG-UI uses `delta`; legacy CopilotKit used `content`
        const chunk = event.delta ?? event.content ?? '';
        if (!(event.messageId in messageBuffer)) {
          // Content without a START event – open the message implicitly
          messageBuffer[event.messageId] = '';
          if (this.onMessageStart) this.onMessageStart(event.messageId, event.agentName ?? this._currentStep);
        }
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
        if (this.onRunStarted) this.onRunStarted(event.runId, event.threadId);
        return null;

      case 'RUN_FINISHED':
      case 'RunFinished': {
        if (this.onRunResult) this.onRunResult(event.result ?? null);
        this._currentStep = null;
        this._fireRunFinished(Object.values(messageBuffer).join(''));
        return null;
      }

      case 'RUN_ERROR':
      case 'RunError': {
        const err = new Error(event.message ?? 'CopilotKit run error');
        err.code = event.code;
        if (this.onError) {
          this.onError(err);
        }
        return null;
      }

      // ── Agent state ──
      case 'AGENT_STATE_MESSAGE':
      case 'AgentStateMessage':
        return null;

      // ── Tool calls (no text output; surfaced via onToolCall) ──
      case 'TOOL_CALL_START':
      case 'ActionExecutionStart': {
        const id = event.toolCallId ?? event.actionExecutionId;
        this._toolCalls[id] = {
          id,
          name: event.toolCallName ?? event.name ?? '',
          args: '',
          status: 'running',
          result: null,
        };
        this._emitToolCall(id);
        return null;
      }
      case 'TOOL_CALL_ARGS':
      case 'ActionExecutionArgs': {
        const id = event.toolCallId ?? event.actionExecutionId;
        if (this._toolCalls[id]) this._toolCalls[id].args += event.delta ?? event.args ?? '';
        return null;
      }
      case 'TOOL_CALL_END':
      case 'ActionExecutionEnd': {
        const id = event.toolCallId ?? event.actionExecutionId;
        if (this._toolCalls[id]) {
          this._toolCalls[id].status = 'done';
          this._emitToolCall(id);
        }
        return null;
      }
      case 'TOOL_CALL_RESULT':
      case 'ActionExecutionResult': {
        const id = event.toolCallId ?? event.actionExecutionId;
        if (this._toolCalls[id]) {
          this._toolCalls[id].result = event.content ?? event.result ?? null;
          this._toolCalls[id].status = 'complete';
          this._emitToolCall(id);
        }
        return null;
      }

      // ── State updates ──
      case 'STATE_SNAPSHOT':
        this.state = event.snapshot ?? {};
        if (this.onStateChange) this.onStateChange(this.state);
        return null;
      case 'STATE_DELTA':
        this.state = this._applyStateDelta(event.delta);
        if (this.onStateChange) this.onStateChange(this.state);
        return null;
      case 'MESSAGES_SNAPSHOT':
        this.messages = (event.messages ?? []).slice(-this.maxHistory);
        if (this.onMessagesSnapshot) this.onMessagesSnapshot(event.messages ?? []);
        return null;
      case 'STEP_STARTED':
        this._currentStep = event.stepName ?? null;
        if (this.onStepStarted) this.onStepStarted(this._currentStep);
        return null;
      case 'STEP_FINISHED':
        if (this.onStepFinished) this.onStepFinished(event.stepName ?? null);
        if (this._currentStep === event.stepName) this._currentStep = null;
        return null;
      case 'CUSTOM':
        if (this.onCustomEvent) this.onCustomEvent(event.name, event.value);
        return null;

      default:
        return null;
    }
  }
}

export default CopilotKitClient;
