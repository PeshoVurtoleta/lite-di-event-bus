# Changelog

All notable changes to `@zakkster/lite-di-event-bus` are documented here. The
format follows Keep a Changelog; the project uses semantic versioning. The
version is synced in three places at once: `package.json`, the `VERSION` const in
`EventBus.js`, and this file's top entry.

## [1.0.0-alpha.1] - 2026-08-09

First scoped release, built on the shipped `@zakkster/lite-di-container` v2.0.0
surface (the `getAllInto` fill-into-caller-buffer form is the feature this
package exists to exercise).

### Added
- `EventBus` class: a boot-locked, DI-constructed event topology over a container
  `multi` binding. Listeners are classes with a `handle(payload)` method; the
  container builds and caches them once at boot, and emit dispatches by array
  index into one bus-owned buffer.
- `on(eventName, ListenerClass, deps?)` -- pre-boot registration only; delegates
  to `container.multi`. Registering after the container is booted throws a static
  topology violation (fail closed).
- `boot()` -- allocates a buffer STACK (one reusable buffer per nesting level,
  MAX_DEPTH = 8), each sized to the largest listener count, so `getAllInto` can
  never `RangeError` at any depth, then boots the container if needed. Idempotent.
- `emit(eventName, payload)` -- synchronous dispatch, 0 bytes/emit (hard-gated at
  zero): one `getAllInto` fill into this nesting level's stack buffer + an index
  loop, no `has()` pre-gate, no private cache. Synchronous re-entrant emit (a
  listener emitting another event) is supported up to 8 levels deep and stays
  zero-alloc; each level takes the next stack buffer, so the outer dispatch is
  never corrupted. A `try/finally` restores the depth even if a handler throws.
  A cascade deeper than 8 throws `emit nesting too deep (max 8)` (fail closed).
- `emitSafe(eventName, payload)` -- isolates each listener; a thrown handler is
  routed to `onError` and dispatch continues.
- `emitAsync(eventName, payload)` -- awaits each listener in registration order.
  PINNED lane: allocates promise machinery by construction, never advertised as
  zero-GC.
- `listenerCount(eventName)`, `VERSION`, `OPTIONS`.

### Fail-closed contract
- Post-shutdown `emit` THROWS (routes through the container, which rejects reads
  after shutdown) instead of dispatching to torn-down instances.
- Constructor option validation: the only valid key is `onError`. An unknown key
  throws with a case-insensitive did-you-mean hint
  (`Unknown option 'onErr'. Did you mean 'onError'?`). A non-function `onError`
  is a `TypeError`. There is no silent `missing:'ignore'` default.
- An unknown event falls through to the container's own unregistered throw.
- Synchronous nested emit is bounded: a cascade deeper than 8 levels throws
  `emit nesting too deep (max 8)` rather than growing unbounded, and the depth
  counter is restored (via `try/finally`) after any throw, so the bus stays
  usable and re-entrancy never corrupts an outer dispatch.

### Proven
- `node --expose-gc test/torture.mjs`: T0 dispatch laws, T3 lifecycle + nested
  re-entrancy (A2, A7, A9, A10), T5 fuzz (32 seeds x 2000 iters flat + 32 x 2000
  nested, A6, A11), T6 the 0 B/emit gate over 1e6 emits WITH a 4-deep cascade in
  the measured body (A1, A8) plus the recorded async lane, T7 soak (2000 cycles +
  500 dispose rounds, lite-leak size 0, peak <= 2x baseline, A5), T9 controls
  (ASCII + per-emit alloc break, A3).
- Per-lane allocation: `emit` 0.000 B/emit (hard gate); `emitAsync` ~0.8 B/op
  (recorded, pinned, not gated).
- ASCII-only source; zero runtime dependencies (the container is a peer
  dependency, not bundled).

[1.0.0-alpha.1]: https://www.npmjs.com/package/@zakkster/lite-di-event-bus
