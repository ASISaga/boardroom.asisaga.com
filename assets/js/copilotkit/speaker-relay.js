/**
 * Speaker relay (purpose-agent#37, boardroom#79): a CUSTOM `speaker_relay`
 * event carries a speaker's model-call identifiers and raw inference
 * ({actor, turn_id, attempt, prompt_ref: {chars, sha256}, otel_trace_id,
 * inference}); prompt text is never relayed. It arrives before
 * that speaker's text events, or on its own later. A missing or
 * unrecognised relay is nothing to show.
 */

export class SpeakerRelay {
  /** CUSTOM event name of the speaker relay. */
  static EVENT = 'speaker_relay';

  /** Relay keys, in display order. Prompt text and Mind context are never relayed. */
  static FIELDS = ['turn_id', 'attempt', 'prompt_chars', 'prompt_sha', 'otel_trace_id', 'inference'];

  /**
   * Normalise a `speaker_relay` value to {actor, turn_id, attempt,
   * prompt_chars, prompt_sha (12-char prefix), otel_trace_id, inference}.
   * Missing values are null. Returns null when nothing is identifiable.
   */
  static normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const ref = value.prompt_ref && typeof value.prompt_ref === 'object' ? value.prompt_ref : {};
    const sha = str(ref.sha256);
    let inference = null;
    if (typeof value.inference === 'string') {
      inference = value.inference || null;
    } else if (value.inference != null) {
      try { inference = JSON.stringify(value.inference, null, 2) ?? null; } catch (_) { inference = null; }
    }
    const relay = {
      actor: str(value.actor),
      turn_id: str(value.turn_id),
      attempt: num(value.attempt),
      prompt_chars: num(ref.chars),
      prompt_sha: sha ? sha.slice(0, 12) : null,
      otel_trace_id: str(value.otel_trace_id),
      inference,
    };
    return SpeakerRelay.FIELDS.some((k) => relay[k] != null) ? relay : null;
  }

  /** `next` over `prev`: a later relay fills in, never blanks, earlier fields. */
  static merge(prev, next) {
    if (!prev) return next;
    const merged = { actor: next.actor ?? prev.actor };
    for (const key of SpeakerRelay.FIELDS) merged[key] = next[key] ?? prev[key];
    return merged;
  }
}

/**
 * Matches one run's speaker relays to that speaker's message. A relay that
 * arrives before the speaker's message opens is held until it does.
 */
export class SpeakerRelayTracker {
  constructor() {
    this.speakerMessages = {}; // speaker (lowercase) -> messageId of their message in this run
    this.pending = {};         // speaker (lowercase) -> relay received before their message started
    this.byMessage = {};       // messageId -> speaker relay
  }

  /**
   * A `speaker_relay` value arrived (`step` is the run's active speaker).
   * @returns {{messageId: string, relay: object}|null} The relay to deliver
   *   now, or null when there is nothing to show or it is held.
   */
  receive(value, step) {
    const relay = SpeakerRelay.normalize(value);
    if (!relay) return null;
    const speaker = String(relay.actor ?? step ?? '').toLowerCase();
    if (!speaker) return null;
    const messageId = this.speakerMessages[speaker];
    if (messageId == null) {
      this.pending[speaker] = SpeakerRelay.merge(this.pending[speaker], relay);
      return null;
    }
    const merged = SpeakerRelay.merge(this.byMessage[messageId], relay);
    this.byMessage[messageId] = merged;
    return { messageId, relay: merged };
  }

  /**
   * A speaker's message opened.
   * @returns {object|null} A held relay to deliver for it now, or null.
   */
  messageStarted(speaker, messageId) {
    const key = String(speaker ?? '').toLowerCase();
    if (!key) return null;
    this.speakerMessages[key] = messageId;
    const pending = this.pending[key];
    if (!pending) return null;
    delete this.pending[key];
    this.byMessage[messageId] = pending;
    return pending;
  }

  /** The relay delivered for `messageId`, if any. */
  forMessage(messageId) {
    return this.byMessage[messageId];
  }
}

export default SpeakerRelay;
