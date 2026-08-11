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
 * Three-place VERSION sync: package.json + this const + CHANGELOG.md are bumped
 * in one commit or not at all.
 * @type {string}
 */
export const VERSION = '1.1.0';

/**
 * The only accepted constructor option keys. Frozen so an unknown key is an
 * error with a did-you-mean hint, never a silent ignore (fail closed).
 * @type {readonly string[]}
 */
export const OPTIONS = Object.freeze(['onError']);

/** Case-insensitive 3-char prefix used by the did-you-mean matcher. */
const PREFIX = 3;

/** One message string shared by every disposed-state guard (on + all emit lanes). */
const DISPOSED = '[EventBus] bus has been disposed.';

/**
 * Maximum synchronous emit nesting depth (a listener emitting another event,
 * that listener emitting another, ...). boot() pre-allocates one reusable buffer
 * per level, so re-entrant emit stays zero-alloc up to this depth; going deeper
 * fails closed rather than corrupting a buffer or growing unbounded.
 */
const MAX_DEPTH = 8;

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
 * index into a bus-owned buffer stack (one reusable buffer per nesting level) --
 * no per-emit allocation, no private listener cache to fall stale, and
 * post-shutdown emit throws (fail closed). Synchronous re-entrant emit (a
 * listener emitting another event) is supported up to MAX_DEPTH levels; deeper
 * throws.
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

        // Cold registration state. _counts sizes the buffer stack at boot; it is
        // never read on the hot path. _bufStack is one reusable buffer per
        // nesting level (allocated at boot); _depth is the live level index.
        this._counts = new Map();
        this._bufStack = null;
        this._depth = 0;
        this._maxCount = 0;
        this._booted = false;

        // Flight recorder (1.1, GAP-5). Single source of truth: _tape === null means
        // no ring is allocated (the release-guarding hot path is one compare against
        // this). A tape object holds pre-sized parallel arrays and its own rolling
        // head/count/dropped so the recording-on lane is 0 B/op too. _replaying is the
        // re-drive latch -- replay() sets it so the re-driven emits do not self-record.
        this._tape = null;
        this._replaying = false;
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
        if (this._container === null) {
            throw new Error(DISPOSED);
        }
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
     * Boot the topology: allocate the buffer stack -- MAX_DEPTH buffers, each
     * sized to the largest listener count (so getAllInto can never RangeError at
     * any nesting depth) -- then boot the container if it is not already booted.
     * Idempotent.
     * @returns {this}
     */
    boot() {
        if (this._container === null) throw new Error(DISPOSED);
        if (this._booted) return this;
        let max = 0;
        for (const n of this._counts.values()) if (n > max) max = n;
        this._maxCount = max;
        const stack = new Array(MAX_DEPTH);
        for (let d = 0; d < MAX_DEPTH; d++) stack[d] = new Array(max);
        this._bufStack = stack;
        this._depth = 0;
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
        if (this._container === null) throw new Error(DISPOSED);
        const n = this._counts.get(eventName);
        return n === undefined ? 0 : n;
    }

    // === Emit (hot path) ===================================================

    /**
     * Dispatch synchronously to every listener, by index, from this nesting
     * level's buffer. Zero allocation per emit (D-EB1): one getAllInto fill + an
     * index loop. Guards, in order: a single field-null compare for the disposed
     * state, then a depth compare against MAX_DEPTH (both cheap predictable
     * compares, NOT has()/Map probes -- still 0 B/emit, proven in T6). A listener
     * that synchronously emits another event takes the NEXT stack buffer, so the
     * outer loop's buffer is never overwritten. The try opens immediately after
     * the depth guard, so the increment AND the getAllInto fill are inside it --
     * every throw (unknown event, post-shutdown container, RangeError, or a
     * handler) restores _depth via the finally, so a fail-closed throw can never
     * leak depth and brick the bus. No has() pre-gate, no cache -- so an emit
     * after the container shuts down THROWS (fail closed), and an unknown event
     * falls through to the container's unregistered throw.
     * @param {string} eventName
     * @param {unknown} payload
     */
    emit(eventName, payload) {
        if (this._container === null) throw new Error(DISPOSED);
        const d = this._depth;
        if (d >= MAX_DEPTH) throw new Error('[EventBus] emit nesting too deep (max ' + MAX_DEPTH + ')');
        try {
            // Recorder hook: exactly one field compare when off (the release-guarding
            // A1 gate). On tape, _capture does reference stores into the pre-allocated
            // ring -- no per-emit allocation. Inside the try so a 'throw'-overflow
            // fail-closed still restores _depth via the finally.
            if (this._tape !== null) this._capture(eventName, payload);
            const buf = this._bufStack[this._depth++];
            const n = this._container.getAllInto(eventName, buf);
            for (let i = 0; i < n; i++) buf[i].handle(payload);
        } finally {
            this._depth = d;
        }
    }

    /**
     * Like emit, but isolates each listener: a thrown handler is routed to
     * onError and dispatch continues. Same depth-indexed buffer stack and
     * try/finally depth restore as emit; the per-listener try/catch is extracted
     * to keep this frame optimizable.
     * @param {string} eventName
     * @param {unknown} payload
     */
    emitSafe(eventName, payload) {
        if (this._container === null) throw new Error(DISPOSED);
        const onError = this._onError;
        const d = this._depth;
        if (d >= MAX_DEPTH) throw new Error('[EventBus] emit nesting too deep (max ' + MAX_DEPTH + ')');
        try {
            if (this._tape !== null) this._capture(eventName, payload);
            const buf = this._bufStack[this._depth++];
            const n = this._container.getAllInto(eventName, buf);
            for (let i = 0; i < n; i++) _callSafe(buf[i], payload, eventName, onError);
        } finally {
            this._depth = d;
        }
    }

    /**
     * Await each listener in registration order. PINNED lane: awaiting allocates
     * promise machinery by construction -- this is NOT a zero-GC path.
     *
     * A stack buffer is taken ONLY for the synchronous getAllInto fill, then the
     * resolved listeners are snapshotted into a FRESH local array and the stack
     * slot is RELEASED (depth restored) BEFORE the first await. Nothing on the
     * shared stack is held across a suspension, so overlapping emitAsync calls
     * never corrupt each other. The snapshot is why this lane allocates -- and
     * why it never claims to be zero.
     * @param {string} eventName
     * @param {unknown} payload
     * @returns {Promise<void>}
     */
    async emitAsync(eventName, payload) {
        if (this._container === null) throw new Error(DISPOSED);
        const onError = this._onError;
        const d = this._depth;
        if (d >= MAX_DEPTH) throw new Error('[EventBus] emit nesting too deep (max ' + MAX_DEPTH + ')');
        // Capture before the slot is taken; a 'throw'-overflow throws before _depth
        // is incremented, so the bus stays usable with no depth leak.
        if (this._tape !== null) this._capture(eventName, payload);
        const buf = this._bufStack[this._depth++];
        let listeners;
        try {
            const n = this._container.getAllInto(eventName, buf);
            // Snapshot before releasing the slot -- the async loop below owns it.
            listeners = new Array(n);
            for (let i = 0; i < n; i++) listeners[i] = buf[i];
        } finally {
            this._depth = d; // release the stack slot BEFORE any await
        }
        for (let i = 0; i < listeners.length; i++) {
            const listener = listeners[i];
            try {
                await listener.handle(payload);
            } catch (err) {
                onError(err, eventName, listener.constructor.name);
            }
        }
    }

    // === Flight recorder (record / replay -- 1.1, GAP-5) ==================

    /**
     * On-tape hook. Called only when this._tape !== null (the hot path already
     * paid that one compare). Zero allocation: reference stores into the
     * pre-allocated ring at the rolling head. Skips while replaying (the re-drive
     * must not self-record) and while the tape is stopped. Under 'drop-oldest' a
     * full ring rotates over the oldest slot and increments dropped(); under
     * 'throw' a full ring throws inside emit (fail closed) BEFORE mutating the
     * head, so the tape stays consistent and the bus usable.
     * @param {string} eventName
     * @param {unknown} payload
     */
    _capture(eventName, payload) {
        if (this._replaying) return;
        const tape = this._tape;
        if (!tape.active) return;
        const cap = tape.capacity;
        if (tape.count === cap) {
            if (tape.onOverflow === 'throw') {
                throw new Error('[EventBus] record tape overflow: capacity ' + cap +
                    " reached under onOverflow 'throw'.");
            }
            tape.dropped++;
        } else {
            tape.count++;
        }
        let head = tape.head;
        tape.names[head] = eventName;
        tape.payloads[head] = payload;
        head++;
        if (head === cap) head = 0;
        tape.head = head;
    }

    /**
     * Begin capturing every emitted (name, payload) into a FIXED ring of exactly
     * `capacity` slots, pre-allocated once here. The recorder is a passive tape:
     * it records what already fired in the same synchronous frame -- it never
     * defers, reorders, or re-delivers. NOT a scheduler.
     *
     * `opts.onOverflow` picks the full-ring policy: 'drop-oldest' (default,
     * flight-recorder semantics -- keep the most recent `capacity` events, rotate,
     * and make loss visible via dropped()) or 'throw' (exact-capture semantics --
     * the capacity+1-th emit throws inside emit; the bus stays usable).
     *
     * Fails closed: disposed bus throws; non-integer or <= 0 `capacity` throws
     * naming it; a second record() while already recording throws (stopRecording()
     * first to restart).
     * @param {number} capacity
     * @param {{ onOverflow?: 'drop-oldest' | 'throw' }} [opts]
     * @returns {this}
     */
    record(capacity, opts) {
        if (this._container === null) throw new Error(DISPOSED);
        if (this._tape !== null && this._tape.active) {
            throw new Error('[EventBus] already recording -- call stopRecording() before record().');
        }
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
            throw new RangeError('[EventBus] record(capacity): capacity must be a positive integer, got ' +
                String(capacity) + '.');
        }
        let onOverflow = 'drop-oldest';
        if (opts !== null && opts !== undefined) {
            for (const key in opts) {
                if (key !== 'onOverflow') {
                    throw new Error("[EventBus] record: unknown option '" + key +
                        "'. Did you mean 'onOverflow'?");
                }
            }
            if (opts.onOverflow !== undefined) {
                if (opts.onOverflow !== 'drop-oldest' && opts.onOverflow !== 'throw') {
                    throw new Error("[EventBus] record: onOverflow must be 'drop-oldest' or 'throw', got '" +
                        String(opts.onOverflow) + "'.");
                }
                onOverflow = opts.onOverflow;
            }
        }
        this._tape = {
            names: new Array(capacity),
            payloads: new Array(capacity),
            head: 0,
            count: 0,
            dropped: 0,
            capacity: capacity,
            onOverflow: onOverflow,
            active: true,
        };
        return this;
    }

    /**
     * Stop capturing. The tape and every retained payload reference are KEPT so
     * replay() still works; call clearTape() to release them. Idempotent -- safe
     * to call when not recording or never recorded.
     * @returns {this}
     */
    stopRecording() {
        if (this._tape !== null) this._tape.active = false;
        return this;
    }

    /**
     * Synchronously re-drive every recorded entry through emit(), in capture
     * order, before the next statement runs (NOT scheduled -- no timer, no
     * microtask, no queue). Returns the count replayed. Recording is suspended for
     * the duration via the _replaying latch (restored in finally), so the re-drive
     * does not self-record. A never-recorded or empty tape returns 0 (absence is a
     * valid empty, not an error). Disposed bus throws; a re-entrant replay() throws.
     * @returns {number}
     */
    replay() {
        if (this._container === null) throw new Error(DISPOSED);
        if (this._replaying) throw new Error('[EventBus] replay re-entered.');
        const tape = this._tape;
        if (tape === null) return 0;
        const count = tape.count;
        if (count === 0) return 0;
        const cap = tape.capacity;
        const names = tape.names;
        const payloads = tape.payloads;
        // When full the oldest entry sits at head; otherwise entries fill 0..count-1.
        const start = count === cap ? tape.head : 0;
        this._replaying = true;
        try {
            for (let i = 0; i < count; i++) {
                let idx = start + i;
                if (idx >= cap) idx -= cap;
                this.emit(names[idx], payloads[idx]);
            }
        } finally {
            this._replaying = false;
        }
        return count;
    }

    /**
     * Entries currently held in the tape (0 when never recorded or after
     * clearTape). Never exceeds the recording capacity.
     * @returns {number}
     */
    recorded() {
        return this._tape === null ? 0 : this._tape.count;
    }

    /**
     * Entries overwritten under 'drop-oldest' overflow -- makes loss VISIBLE
     * (fail-loud via a counter, never a silent drop). Always 0 under 'throw'.
     * @returns {number}
     */
    dropped() {
        return this._tape === null ? 0 : this._tape.dropped;
    }

    /**
     * Release every retained payload reference (null the slots so a WeakRef to a
     * recorded payload becomes collectable) and reset head/count/dropped. The ring
     * arrays are REUSED, not reallocated. Idempotent. Recording continues if it was
     * active -- clearTape only empties the tape, it does not stop it.
     * @returns {this}
     */
    clearTape() {
        const tape = this._tape;
        if (tape === null) return this;
        const names = tape.names;
        const payloads = tape.payloads;
        for (let i = 0; i < names.length; i++) {
            names[i] = null;
            payloads[i] = null;
        }
        tape.head = 0;
        tape.count = 0;
        tape.dropped = 0;
        return this;
    }

    /**
     * Release the bus. Nulls the container reference, the buffer stack (whose
     * buffers can pin torn-down instances), the counts map, and the error sink,
     * and resets the depth counter. After dispose, emit* and on() fail closed
     * (throw). Call this on a long-lived bus after the container has shut down.
     * @returns {this}
     */
    dispose() {
        this._bufStack = null;
        this._depth = 0;
        this._maxCount = 0;
        this._container = null;
        this._counts = null;
        this._onError = null;
        this._booted = false;
        // Fail closed: the tape must never outlive the bus. Nulling it releases the
        // ring arrays and every retained payload reference in one shot.
        this._tape = null;
        this._replaying = false;
        return this;
    }
}
