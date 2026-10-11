/**
 * Incremental Server-Sent Events reader for AG-UI streams.
 *
 * The body is read chunk by chunk from response.body, so RUN_STARTED,
 * keepalive comments and speaker events are handled as they arrive; never
 * read an SSE body with response.text()/json(), which buffers until the
 * turn ends.
 */

export class SseReader {
  /**
   * Read every `data:` line of the response body and hand its parsed JSON
   * to `onEvent`. Comments (keepalives), blank data and `[DONE]` are
   * skipped; unparseable data is logged at debug level and skipped.
   *
   * @param {Response} response
   * @param {(event: object) => void} onEvent
   * @returns {Promise<void>} Resolves when the body is fully read.
   */
  static async read(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (line) => {
      const event = SseReader.parseLine(line);
      if (event) onEvent(event);
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
  }

  /** The JSON event of one SSE line, or null for anything else. */
  static parseLine(line) {
    if (!line.startsWith('data:')) return null;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return null;
    try {
      return JSON.parse(dataStr);
    } catch (parseError) {
      // Malformed JSON – log at debug level and skip
      console.debug('[CopilotKit] Skipping unparseable SSE data:', dataStr, parseError);
      return null;
    }
  }
}

export default SseReader;
