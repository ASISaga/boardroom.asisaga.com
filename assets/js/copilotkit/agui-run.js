/**
 * One AG-UI run (Boardroom spec 07): a send or a hydrate, keyed by its own
 * runId. Each run owns its AbortController, active step and message
 * buffers, so a new send never aborts an in-flight turn.
 */

import { AgUiHttp } from './agui-http.js';
import { SpeakerRelayTracker } from './speaker-relay.js';

export class AgUiRun {
  /** @param {string} source - Envelope source ('agui', 'hydrate', …). */
  constructor(source) {
    this.runId = AgUiHttp.randomUUID();
    this.source = source;
    this.controller = new AbortController();
    this.step = null;            // active speaker of this run (STEP_STARTED.stepName)
    this.messageBuffer = {};     // messageId -> accumulated text
    this.speakers = {};          // messageId -> speaker
    this.messages = [];          // completed assistant messages, one per messageId
    this.relays = new SpeakerRelayTracker();
    this.finished = false;       // RUN_FINISHED or RUN_ERROR seen
    this.finishedFired = false;  // onRunFinished delivered
    this.error = null;           // Error built from RUN_ERROR
    this.result = undefined;     // RUN_FINISHED.result
  }

  /**
   * True only for a RUN_FINISHED.result that is a turn's Digest: present and
   * not the `{cancelled: true}` of a cancelled turn (07). A hydrate's
   * RUN_FINISHED carries no result and is not a turn.
   */
  static isCompletedTurn(result) {
    return result != null && !(typeof result === 'object' && result.cancelled === true);
  }

  /** Mark the run failed with a RUN_ERROR (terminal; never a RUN_FINISHED). */
  fail({ message, code }) {
    const err = new Error(message ?? 'CopilotKit run error');
    err.name = 'RunError';
    err.code = code;
    err.runId = this.runId;
    this.error = err;
    this.step = null;
    this.finished = true;
    return err;
  }
}

export default AgUiRun;
