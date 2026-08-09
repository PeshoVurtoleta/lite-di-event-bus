// @zakkster/lite-di-event-bus
// DI-constructed static handlers under a boot-locked `multi` topology,
// dispatched by index. Not a plain emitter: listeners are classes the
// container builds and owns; emit routes through the container so it fails
// closed after shutdown. Sync emit is 0 B/emit (hard-gated); emitAsync
// allocates promise machinery by construction (pinned, never zero).
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

/**
 * Three-place VERSION sync: package.json + this const + CHANGELOG.md + llms.txt
 * are bumped in one commit or not at all.
 * @type {string}
 */
export const VERSION = '1.0.0-alpha.1';

/**
 * The only accepted constructor option keys. Frozen so an unknown key is an
 * error with a did-you-mean hint, never a silent ignore (fail closed).
 * @type {readonly string[]}
 */
export const OPTIONS = Object.freeze(['onError']);

/** Case-insensitive 3-char prefix used by the did-you-mean matcher. */
const PREFIX = 3;

/**
 * Default error sink for emitSafe/emitAsync. Overridable via `{ onError }`.
 * Reports and continues -- it never swallows silently.
 * @param {unknown} err
 * @param {string} eventName
 * @param {string} listenerName
 */
function _defaultOnError(err, eventName, listenerName) {
    console.error('[EventBus] listener ' + listenerName +
        " threw on '" + eventName + "':", err);
}

/**
 * Cold-path did-you-mean. Builds a suggestion for an unknown option key by a
 * case-insensitive 3-char prefix match against OPTIONS. Only ever called when a
 * key is already known-bad, so it allocates nothing on the happy path.
 * @param {string} key
 * @returns {string} the matched option, or '' if none.
 */
function _suggest(key) {
    const p = String(key).slice(0, PREFIX).toLowerCase();
    for (let i = 0; i < OPTIONS.length; i++) {
        if (OPTIONS[i].slice(0, PREFIX).toLowerCase() === p) return OPTIONS[i];
    }
    return '';
}

/**
 * Extracted so the per-listener try/catch never lands in emitSafe's frame --
 * a try/catch in the hot body deoptimizes the whole function under V8.
 * @param {{ handle: (payload: unknown) => unknown }} listener
 * @param {unknown} payload
 * @param {string} eventName
 * @param {(err: unknown, eventName: string, listenerName: string) => void} onError
 */
function _callSafe(listener, payload, eventName, onError) {
    try {
        listener.handle(payload);
    } catch (err) {
        onError(err, eventName, listener.constructor.name);
    }
}

/**
 * A boot-locked, DI-constructed event topology over an @zakkster/lite-di-container
 * `multi` binding. Listeners are classes with a `handle(payload)` method; the
 * container builds and caches them once at boot, and emit dispatches by array
 * index into a single bus-owned buffer -- no per-emit allocation, no private
 * listener cache to fall stale, and post-shutdown emit throws (fail closed).
 */
export class EventBus {
    /**
     * @param {import('@zakkster/lite-di-container').Container} container
     * @param {{ onError?: (err: unknown, eventName: string, listenerName: string) => void }} [options]
     */
    constructor(container, options) {
        if (container === null || container === undefined) {
            throw new TypeError('[EventBus] container is required.');
        }
        this._container = container;

        // Validate option keys. for-in allocates no array; the happy path (no
        // unknown key) does zero work beyond the walk. An unknown key fails
        // closed with a did-you-mean hint (D-EB4).
        let onError = _defaultOnError;
        if (options !== null && options !== undefined) {
            for (const key in options) {
                if (key !== 'onError') {
                    const hint = _suggest(key);
                    throw new Error("[EventBus] Unknown option '" + key + "'." +
                        (hint === '' ? '' : " Did you mean '" + hint + "'?"));
                }
            }
            if (options.onError !== undefined) {
                if (typeof options.onError !== 'function') {
                    throw new TypeError('[EventBus] onError must be a function.');
                }
                onError = options.onError;
            }
        }
        this._onError = onError;

        // Cold registration state. _counts sizes the shared buffer at boot; it
        // is never read on the hot path.
        this._counts = new Map();
        this._buf = null;
        this._booted = false;
    }

    // === Registration (cold path -- pre-boot only) =========================

    /**
     * Register a listener class under an event name. Pre-boot only: registering
     * after the container is booted is a static-topology violation (fail closed).
     * Delegates the binding to `container.multi`.
     * @param {string} eventName
     * @param {new (...args: any[]) => { handle: (payload: unknown) => unknown }} ListenerClass
     * @param {string[]} [deps]
     * @returns {this}
     */
    on(eventName, ListenerClass, deps) {
        if (this._container.isBooted) {
            throw new Error("[EventBus] Static topology violation: cannot register '" +
                eventName + "' after boot.");
        }
        this._container.multi(eventName, ListenerClass, deps === undefined ? [] : deps);
        const n = this._counts.get(eventName);
        this._counts.set(eventName, n === undefined ? 1 : n + 1);
        return this;
    }

    /**
     * Boot the topology: allocate ONE shared buffer sized to the largest
     * listener count (so getAllInto can never RangeError), then boot the
     * container if it is not already booted. Idempotent.
     * @returns {this}
     */
    boot() {
        if (this._booted) return this;
        let max = 0;
        for (const n of this._counts.values()) if (n > max) max = n;
        this._buf = new Array(max);
        if (!this._container.isBooted) this._container.boot();
        this._booted = true;
        return this;
    }

    // === Introspection (cold path) =========================================

    /**
     * Number of listeners registered under an event name.
     * @param {string} eventName
     * @returns {number}
     */
    listenerCount(eventName) {
        const n = this._counts.get(eventName);
        return n === undefined ? 0 : n;
    }

    // === Emit (hot path) ===================================================

    /**
     * Dispatch synchronously to every listener, by index, from the shared
     * buffer. Zero allocation per emit (D-EB1): one getAllInto fill + an index
     * loop. No has() pre-gate, no cache, no try/catch -- so an emit after the
     * container shuts down THROWS (fail closed), and an unknown event falls
     * through to the container's unregistered throw.
     * @param {string} eventName
     * @param {unknown} payload
     */
    emit(eventName, payload) {
        const buf = this._buf;
        const n = this._container.getAllInto(eventName, buf);
        for (let i = 0; i < n; i++) buf[i].handle(payload);
    }

    /**
     * Like emit, but isolates each listener: a thrown handler is routed to
     * onError and dispatch continues. The per-listener try/catch is extracted
     * to keep this frame optimizable.
     * @param {string} eventName
     * @param {unknown} payload
     */
    emitSafe(eventName, payload) {
        const buf = this._buf;
        const onError = this._onError;
        const n = this._container.getAllInto(eventName, buf);
        for (let i = 0; i < n; i++) _callSafe(buf[i], payload, eventName, onError);
    }

    /**
     * Await each listener in registration order. PINNED lane: awaiting allocates
     * promise machinery by construction -- this is NOT a zero-GC path. Reuses
     * the sync buffer, so do not re-enter emit* from within an awaited handler.
     * @param {string} eventName
     * @param {unknown} payload
     * @returns {Promise<void>}
     */
    async emitAsync(eventName, payload) {
        const buf = this._buf;
        const onError = this._onError;
        const n = this._container.getAllInto(eventName, buf);
        for (let i = 0; i < n; i++) {
            const listener = buf[i];
            try {
                await listener.handle(payload);
            } catch (err) {
                onError(err, eventName, listener.constructor.name);
            }
        }
    }
}
