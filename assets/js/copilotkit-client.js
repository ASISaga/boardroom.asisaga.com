/**
 * CopilotKit Client for Boardroom
 *
 * Connects the boardroom chatroom to a server-side CopilotKit runtime
 * using the AG-UI HTTP protocol (@copilotkit/sdk-js compatible).
 *
 * Protocol: POST JSON → Accept: text/event-stream SSE response
 * Events follow the AG-UI standard (TextMessageStart/Content/End, ToolCallStart/Args/End,
 * RunStarted, RunFinished, RunError, StateSnapshot, StateDelta).
 *
 * Run lifecycle (Boardroom spec 07): every request is one AG-UI run, keyed by
 * its own runId, so several runs may be in flight on the shared thread at
 * once (user interjection). Each run has its own AbortController, active
 * step and message buffer. Only a RUN_FINISHED whose `result` is a Digest is
 * a completed turn; a hydrate's RUN_FINISHED carries no result and a
 * cancelled turn's carries `{cancelled: true}`. RUN_ERROR is terminal and is
 * never followed by RUN_FINISHED.
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
   * @param {string[]} [options.roster]    - Known speaker role ids. When set,
   *   a STEP_STARTED/STEP_FINISHED whose stepName is not in the roster is
   *   informative-only: it is ignored and never rendered as a speaker.
   */
  constructor(options = {}) {
    this.runtimeUrl = options.runtimeUrl || '/ag-ui';
    this.threadId = options.threadId || CopilotKitClient.randomUUID();
    this.agentName = options.agentName || null;
    this.extraHeaders = options.headers || {};
    this.maxHistory = options.maxHistory ?? 50;
    this.getAccessToken = options.getAccessToken || null;
    this.roster = Array.isArray(options.roster)
      ? new Set(options.roster.map((r) => String(r).toLowerCase()))
      : null;
    this.messages = [];

    // In-flight runs keyed by runId: {runId, source, controller, step,
    // messageBuffer, speakers, finished, error, result}. Each run owns its
    // AbortController, so a new send never aborts an in-flight turn.
    this._runs = new Map();

    // Last completed turn (Digest-bearing RUN_FINISHED). Cancelled turns and
    // hydrates never advance it (07).
    this.lastSeen = null;

    // Shared agent state (AG-UI STATE_SNAPSHOT / STATE_DELTA), round-tripped
    // to the backend in each RunAgentInput.state.
    this.state = options.state || {};
    this._toolCalls = {};

    // Callbacks. `runId` is the AG-UI run the event belongs to.
    this.onStepStarted = null;   // (speaker, runId) => void
    this.onStepFinished = null;  // (speaker, runId) => void
    this.onProtocolEvent = null; // (event, runId) => void  (every AG-UI event received)
    this.onCustomEvent = null;   // (name, value, runId) => void
    this.onRunResult = null;     // (result, runId) => void  (any RUN_FINISHED.result, may be undefined)
    this.onTurnComplete = null;  // (digest, runId) => void  (Digest-bearing RUN_FINISHED only)
    this.onRunStarted = null;    // (runId, threadId, source) => void  (threadId is server-minted)
    this.onStateChange = null;   // (state) => void
    this.onToolCall = null;      // ({id, name, args, status, result}) => void
    this.onMessagesSnapshot = null; // (messages) => void
    this.onStreamChunk = null;   // (chunk, messageId, runId) => void
    this.onMessageStart = null;  // (messageId, agentName?, runId) => void
    this.onMessageEnd = null;    // (messageId, fullContent, runId) => void
    this.onRunFinished = null;   // (finalContent, runId) => void  (never after RUN_ERROR)
    this.onError = null;         // (error, runId?) => void  (error.code from RUN_ERROR)
  }

  // ── Run classification ─────────────────────────────────────────────────

  /**
   * True only for a RUN_FINISHED.result that is a turn's Digest: present and
   * not the `{cancelled: true}` of a cancelled turn (07). A hydrate's
   * RUN_FINISHED carries no result and is not a turn.
   */
  static isCompletedTurn(result) {
    return result != null && !(typeof result === 'object' && result.cancelled === true);
  }

  /** True while any run (send or hydrate) is in flight. */
  isRunning() {
    for (const run of this._runs.values()) {
      if (!run.finished) return true;
    }
    return false;
  }

  /** In-flight runs, oldest first: [{runId, source}]. */
  inFlightRuns() {
    return [...this._runs.values()]
      .filter((run) => !run.finished)
      .map(({ runId, source }) => ({ runId, source }));
  }

  _isRosterStep(stepName) {
    if (!stepName) return false;
    return !this.roster || this.roster.has(String(stepName).toLowerCase());
  }

  _newRun(source) {
    const run = {
      runId: CopilotKitClient.randomUUID(),
      source,
      controller: new AbortController(),
      step: null,            // active speaker of this run (STEP_STARTED.stepName)
      messageBuffer: {},     // messageId -> accumulated text
      speakers: {},          // messageId -> speaker
      messages: [],          // completed assistant messages, one per messageId
      finished: false,       // RUN_FINISHED or RUN_ERROR seen
      finishedFired: false,  // onRunFinished delivered
      error: null,           // Error built from RUN_ERROR
      result: undefined,     // RUN_FINISHED.result
    };
    this._runs.set(run.runId, run);
    return run;
  }

  async _buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...this.extraHeaders,
      ...extra,
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
    return headers;
  }

  /**
   * Error for a non-2xx response: `status`, plus `detail` when the body is
   * a JSON `{"detail": "..."}` (e.g. the 403 for an unregistered tenant).
   */
  static async _httpError(response, prefix) {
    const errText = await response.text().catch(() => response.statusText);
    const err = new Error(`${prefix} ${response.status}: ${errText}`);
    err.status = response.status;
    try {
      const body = JSON.parse(errText);
      if (body && typeof body.detail === 'string') err.detail = body.detail;
    } catch (_) { /* not JSON */ }
    return err;
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
    this.lastSeen = null;
  }

  /** Continue an existing thread (e.g. the boardroom conversation id) */
  setThread(threadId) {
    this.threadId = threadId || CopilotKitClient.randomUUID();
    this.messages = [];
    this.state = {};
    this._toolCalls = {};
    this.lastSeen = null;
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

  _addMessage(role, content, extra = {}) {
    const message = {
      id: extra.id || CopilotKitClient.randomUUID(),
      role,
      content,
      ...(extra.name ? { name: extra.name } : {}),
    };
    this.messages.push(message);
    // Trim history to stay within the configured maximum
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }
    return message;
  }

  // ── Core send ────────────────────────────────────────────────────────────

  /**
   * Send a user message to the CopilotKit runtime and stream the response.
   *
   * The run gets its own AbortController: sending while another turn is in
   * flight (07 user interjection) never aborts that turn's stream.
   *
   * @param {string} userMessage - The user's text input
   * @param {object} [options]   - Additional options (context, headers, etc.)
   * @param {string} [options.source] - Envelope source of the run (default 'agui')
   * @returns {Promise<{runId: string, result: *, messages: Array<{id, name, content}>}>}
   *   The run's RUN_FINISHED.result and one assistant message per
   *   messageId/speaker. Rejects with the RUN_ERROR (error.code, error.runId)
   *   when the run fails.
   */
  async sendMessage(userMessage, options = {}) {
    const userTurn = this._addMessage('user', userMessage);
    const run = this._newRun(options.source || 'agui');

    const requestBody = {
      threadId: this.threadId,
      runId: run.runId,
      // The backend relays only the latest user utterance to the boardroom
      // (it discards assistant/tool history and rejects tool calls), and
      // durable history lives server-side in mind. Send just the new turn.
      messages: [userTurn],
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

    try {
      const headers = await this._buildHeaders(options.headers);
      const response = await fetch(this.runtimeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: run.controller.signal,
      });

      if (!response.ok) {
        throw await CopilotKitClient._httpError(response, 'Boardroom error');
      }

      await this._processSSEStream(response, run);

      if (run.error) throw run.error;

      return { runId: run.runId, result: run.result, messages: [...run.messages] };
    } catch (error) {
      run.finished = true;
      // A RUN_ERROR was already reported through onError when it arrived.
      if (error.name !== 'AbortError' && error !== run.error) {
        if (this.onError) {
          this.onError(error, run.runId);
        }
      }
      throw error;
    } finally {
      run.finished = true;
      this._runs.delete(run.runId);
    }
  }

  /**
   * Hydrate the thread from the backend (known threadId, empty messages,
   * no O invocation). The server answers from mind with the last turns as
   * a MESSAGES_SNAPSHOT and a STATE_SNAPSHOT. A hydrate is not a turn: its
   * RUN_FINISHED carries no result and never fires onTurnComplete.
   *
   * @returns {Promise<void>}
   */
  async hydrate(options = {}) {
    const run = this._newRun('hydrate');
    try {
      const headers = await this._buildHeaders();
      const response = await fetch(this.runtimeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          threadId: this.threadId,
          runId: run.runId,
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: options.forwardedProps || {},
        }),
        signal: run.controller.signal,
      });
      if (!response.ok) {
        throw await CopilotKitClient._httpError(response, 'Boardroom hydrate error');
      }
      await this._processSSEStream(response, run);
      if (run.error) throw run.error;
    } finally {
      run.finished = true;
      this._runs.delete(run.runId);
    }
  }

  /**
   * Abort in-progress streams: the given run, or every in-flight run
   * (sends and hydrates) when no runId is passed (e.g. on unload).
   */
  abort(runId) {
    for (const run of [...this._runs.values()]) {
      if (runId && run.runId !== runId) continue;
      run.controller.abort();
    }
  }

  // ── SSE stream processing ────────────────────────────────────────────────

  async _processSSEStream(response, run) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      let event;
      try {
        event = JSON.parse(dataStr);
      } catch (parseError) {
        // Malformed JSON – log at debug level and skip
        console.debug('[CopilotKit] Skipping unparseable SSE data:', dataStr, parseError);
        return;
      }
      // Nothing may follow a run's RUN_FINISHED or RUN_ERROR (AG-UI lifecycle).
      if (run.finished) {
        console.debug('[CopilotKit] Ignoring event after run end:', event.type);
        return;
      }
      if (this.onProtocolEvent) {
        try {
          this.onProtocolEvent(event, run.runId);
        } catch (hookError) {
          console.debug('[CopilotKit] onProtocolEvent failed:', hookError);
        }
      }
      const chunk = this._processEvent(event, run);
      if (chunk) {
        fullContent += chunk;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on newlines; keep incomplete last chunk
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(handleLine);
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } finally {
      reader.releaseLock();
    }

    // A run that errored is not a finished run (07: RUN_ERROR is terminal and
    // is not RUN_FINISHED). A stream that closed without either still ends
    // the run for the UI.
    if (!run.error) this._fireRunFinished(fullContent, run);
    return fullContent;
  }

  _fireRunFinished(content, run) {
    if (run.finishedFired) return;
    run.finishedFired = true;
    run.finished = true;
    if (this.onRunFinished) this.onRunFinished(content, run.runId);
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
   * @param {object} event - Parsed JSON event
   * @param {object} run   - The run the event belongs to (see _newRun)
   * @returns {string|null} - Streamed text chunk, if any
   */
  _processEvent(event, run) {
    const { type } = event;
    const messageBuffer = run.messageBuffer;

    switch (type) {
      // ── Message start ──
      case 'TEXT_MESSAGE_START':
      case 'TextMessageStart': {
        messageBuffer[event.messageId] = '';
        run.speakers[event.messageId] = event.agentName ?? run.step;
        if (this.onMessageStart) {
          this.onMessageStart(event.messageId, run.speakers[event.messageId], run.runId);
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
          run.speakers[event.messageId] = event.agentName ?? run.step;
          if (this.onMessageStart) {
            this.onMessageStart(event.messageId, run.speakers[event.messageId], run.runId);
          }
        }
        messageBuffer[event.messageId] = (messageBuffer[event.messageId] ?? '') + chunk;
        if (this.onStreamChunk) {
          this.onStreamChunk(chunk, event.messageId, run.runId);
        }
        return chunk;
      }

      // ── Message end ──
      case 'TEXT_MESSAGE_END':
      case 'TextMessageEnd': {
        const full = messageBuffer[event.messageId] ?? '';
        const speaker = run.speakers[event.messageId] ?? null;
        // One history entry per messageId (per speaker per turn) — never
        // every speaker's deltas joined into one assistant message.
        if (full) {
          const message = this._addMessage('assistant', full, { id: event.messageId, name: speaker });
          run.messages.push({ id: message.id, name: speaker, content: full });
        }
        if (this.onMessageEnd) {
          this.onMessageEnd(event.messageId, full, run.runId);
        }
        delete messageBuffer[event.messageId];
        delete run.speakers[event.messageId];
        return null;
      }

      // ── Run lifecycle ──
      case 'RUN_STARTED':
      case 'RunStarted':
        if (this.onRunStarted) this.onRunStarted(event.runId ?? run.runId, event.threadId, run.source);
        return null;

      case 'RUN_FINISHED':
      case 'RunFinished': {
        const result = event.result;
        run.result = result;
        run.step = null;
        run.finished = true;
        if (this.onRunResult) this.onRunResult(result, run.runId);
        // Only a Digest-bearing RUN_FINISHED is a completed turn (07): a
        // hydrate carries no result, and a cancelled turn's RUN_FINISHED
        // MUST NOT advance last_seen.
        if (run.source !== 'hydrate' && CopilotKitClient.isCompletedTurn(result)) {
          this.lastSeen = {
            runId: run.runId,
            turnId: result?.turn_id ?? null,
            ts: result?.ts ?? new Date().toISOString(),
          };
          if (this.onTurnComplete) this.onTurnComplete(result, run.runId);
        }
        this._fireRunFinished(Object.values(messageBuffer).join(''), run);
        return null;
      }

      case 'RUN_ERROR':
      case 'RunError': {
        // Terminal: nothing follows it, and it is never a RUN_FINISHED.
        const err = new Error(event.message ?? 'CopilotKit run error');
        err.name = 'RunError';
        err.code = event.code;
        err.runId = run.runId;
        run.error = err;
        run.step = null;
        run.finished = true;
        if (this.onError) {
          this.onError(err, run.runId);
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

      // ── Speaker presence (07: stepName is the speaker's role id) ──
      case 'STEP_STARTED': {
        const stepName = event.stepName ?? null;
        // A step that is not a roster speaker is informative-only.
        if (!this._isRosterStep(stepName)) return null;
        run.step = stepName;
        if (this.onStepStarted) this.onStepStarted(stepName, run.runId);
        return null;
      }
      case 'STEP_FINISHED': {
        const stepName = event.stepName ?? null;
        if (!this._isRosterStep(stepName)) return null;
        if (run.step === stepName) run.step = null;
        if (this.onStepFinished) this.onStepFinished(stepName, run.runId);
        return null;
      }
      case 'CUSTOM':
        if (this.onCustomEvent) this.onCustomEvent(event.name, event.value, run.runId);
        return null;

      default:
        return null;
    }
  }
}

export default CopilotKitClient;
