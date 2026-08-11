// Type declarations for @zakkster/lite-di-event-bus.
// The container is a peer dependency; its Container type is imported by name.

import type { Container } from '@zakkster/lite-di-container';

/** Three-place-synced version string (package.json + VERSION const + CHANGELOG). */
export declare const VERSION: string;

/** The only accepted constructor option keys. Frozen. */
export declare const OPTIONS: readonly ['onError'];

/** A listener class the container constructs; its instances handle a payload. */
export interface Listener<P = unknown> {
    handle(payload: P): unknown;
}

/** Constructor signature the bus registers under an event name. */
export type ListenerClass<P = unknown> = new (...deps: any[]) => Listener<P>;

/** Reporter for a thrown handler under emitSafe / emitAsync. */
export type OnError = (err: unknown, eventName: string, listenerName: string) => void;

export interface EventBusOptions {
    /** Error sink for emitSafe / emitAsync. Defaults to a console.error reporter. */
    onError?: OnError;
}

/** Full-ring overflow policy for the flight recorder. */
export type OnOverflow = 'drop-oldest' | 'throw';

export interface RecordOptions {
    /**
     * Full-ring policy: 'drop-oldest' (default -- keep the most recent `capacity`
     * events, rotate, loss visible via dropped()) or 'throw' (the capacity+1-th
     * emit throws inside emit; the bus stays usable).
     */
    onOverflow?: OnOverflow;
}

/**
 * A boot-locked, DI-constructed event topology over a container `multi` binding.
 * Listeners are classes with a `handle(payload)` method; the container builds and
 * caches them once at boot, and emit dispatches by array index into a single
 * bus-owned buffer -- zero allocation per synchronous emit, and post-shutdown
 * emit throws (fail closed).
 */
export declare class EventBus {
    constructor(container: Container, options?: EventBusOptions);

    /** Register a listener class under an event name. Pre-boot only. */
    on<P = unknown>(eventName: string, ListenerClass: ListenerClass<P>, deps?: string[]): this;

    /** Allocate the shared buffer and boot the container if needed. Idempotent. */
    boot(): this;

    /** Number of listeners registered under an event name. */
    listenerCount(eventName: string): number;

    /** Dispatch synchronously to every listener, by index. Zero allocation. */
    emit(eventName: string, payload?: unknown): void;

    /** Like emit, but a thrown handler is routed to onError and dispatch continues. */
    emitSafe(eventName: string, payload?: unknown): void;

    /** Await each listener in registration order. Allocates by construction. */
    emitAsync(eventName: string, payload?: unknown): Promise<void>;

    /**
     * Begin capturing every emitted (name, payload) into a FIXED ring of exactly
     * `capacity` slots (added 1.1.0). Passive recorder, not a scheduler. Fails
     * closed: disposed throws; a non-integer or <= 0 capacity throws; an unknown
     * option throws; a second record() while already recording throws.
     */
    record(capacity: number, opts?: RecordOptions): this;

    /** Halt capture but RETAIN the tape + payloads so replay() still works. Idempotent. */
    stopRecording(): this;

    /**
     * Synchronously re-drive every recorded entry through emit() in capture order;
     * return the count. Recording is suspended for the duration so replay never
     * self-records. Empty/never-recorded returns 0. Disposed throws; re-entrant
     * replay() throws.
     */
    replay(): number;

    /** Entries currently held in the tape (never exceeds capacity; 0 after clearTape). */
    recorded(): number;

    /** Entries overwritten under 'drop-oldest' (loss visible; always 0 under 'throw'). */
    dropped(): number;

    /**
     * Release every retained payload reference (so a WeakRef to a recorded payload
     * is collectable) and reset the tape counters. Ring arrays are reused.
     * Idempotent; recording continues if it was active.
     */
    clearTape(): this;

    /**
     * Release the bus: null the container, shared buffer, counts map, error sink,
     * and the recorder tape. After dispose, emit* and on() fail closed (throw).
     * Call on a long-lived bus once the container has shut down.
     */
    dispose(): this;
}
