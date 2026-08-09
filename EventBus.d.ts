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
     * Release the bus: null the container, shared buffer, counts map, and error
     * sink. After dispose, emit* and on() fail closed (throw). Call on a
     * long-lived bus once the container has shut down.
     */
    dispose(): this;
}
