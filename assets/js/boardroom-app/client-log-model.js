/**
 * Client-library log lines (MSAL and the like), kept apart from the board's
 * events (visible board, step 4; issue #75). DOM-free: a bounded buffer and
 * a persisted "show" switch that is off by default.
 */

export const CLIENT_LOG_STORAGE_KEY = 'boardroom-client-log-visible';
export const CLIENT_LOG_MAX = 200;
export const CLIENT_LOG_SOURCES = new Set(['MSAL']);

/** True for a log source that is a browser library, not the board. */
export function isClientLibrarySource(source) {
    return CLIENT_LOG_SOURCES.has(String(source || ''));
}

export class ClientLogBuffer {
    /** @param {{storage?: Storage|null, max?: number}} [options] */
    constructor({ storage = null, max = CLIENT_LOG_MAX } = {}) {
        this.storage = storage;
        this.max = max;
        this.entries = [];
        this.dropped = 0;
        this._visible = false;   // used when storage is unavailable
        try {
            this._visible = this.storage?.getItem(CLIENT_LOG_STORAGE_KEY) === 'true';
        } catch (e) { /* storage unavailable: off */ }
    }

    /** Off unless the user switched it on. */
    get visible() {
        return this._visible;
    }

    setVisible(visible) {
        this._visible = visible === true;
        try {
            if (this._visible) this.storage?.setItem(CLIENT_LOG_STORAGE_KEY, 'true');
            else this.storage?.removeItem(CLIENT_LOG_STORAGE_KEY);
        } catch (e) { /* storage unavailable: kept for this page only */ }
    }

    /** Keep a line (the oldest go first past `max`). */
    add({ source = 'MSAL', level = 'info', text = '' } = {}) {
        const entry = { source: String(source), level: String(level), text: String(text), at: Date.now() };
        this.entries.push(entry);
        if (this.entries.length > this.max) {
            this.entries.shift();
            this.dropped += 1;
        }
        return entry;
    }

    /** The lines to show at a log level rank filter, or none while hidden. */
    shown(allowed = () => true) {
        if (!this.visible) return [];
        return this.entries.filter((e) => allowed(e.level));
    }
}
