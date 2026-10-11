/**
 * Speaker relay (purpose-agent#37, boardroom#79): a CUSTOM `speaker_relay`
 * event carries a speaker's hydrated Mind context, exact LLM prompt and raw
 * inference ({actor, mind_context, prompt, inference}). It arrives before
 * that speaker's text events, or on its own later. A missing or
 * unrecognised relay is nothing to show.
 */

export class SpeakerRelay {
  /** CUSTOM event name of the speaker relay. */
  static EVENT = 'speaker_relay';

  /** Relay value keys, in display order. */
  static FIELDS = ['mind_context', 'prompt', 'inference'];

  /**
   * Normalise a `speaker_relay` value to {actor, mind_context, prompt,
   * inference}, each a string or null (a non-string value is shown as JSON).
   * Returns null for anything with no relay text: nothing to show.
   */
  static normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const relay = { actor: typeof value.actor === 'string' && value.actor ? value.actor : null };
    let any = false;
    for (const key of SpeakerRelay.FIELDS) {
      const raw = value[key];
      let text = null;
      if (typeof raw === 'string') {
        text = raw;
      } else if (raw != null) {
        try { text = JSON.stringify(raw, null, 2) ?? null; } catch (_) { text = null; }
      }
      relay[key] = text ? text : null;
      if (relay[key]) any = true;
    }
    return any ? relay : null;
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
