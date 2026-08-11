# Changelog

All notable changes to `@zakkster/lite-di-event-bus` are documented here. The
format follows Keep a Changelog; the project uses semantic versioning. The
version is synced in three places at once: `package.json`, the `VERSION` const in
`EventBus.js`, and this file's top entry.

## [1.0.0] - 2026-08-11

Promotion to stable. The public surface is frozen exactly as shipped at
`1.0.0-alpha.1` -- the `EventBus` class (`on`, `boot`, `emit`, `emitSafe`,
`emitAsync`, `listenerCount`, `dispose`), plus `VERSION` and the frozen `OPTIONS`. No
exports added or removed.

### Changed
- The retention gate is now a real finalization residual, not a `size() === 0`
  tautology. The soak tracks each build/emit/dispose cycle WITHOUT untracking,
  settles hard, and asserts the finalization residual stays within a fixed ceiling
  (`size() <= 16`) that does NOT scale with cycle count -- so a per-cycle leak trips
  it directly, not merely a heap backstop. Behavior unchanged; this is the gate that
  now PROVES leak-freedom.

### Proven
- Downstream consumer: `examples/order-pipeline.mjs`, a self-verifying reference app
  that boots a real container, registers listeners as DI-constructed classes, and
  asserts synchronous fan-out order, re-entrant (nested) emit correctness, the
  `emitSafe` error-isolation path, and the post-shutdown fail-closed throw with
  `node:assert`. `npm run example` is a hard gate folded into `verify` /
  `prepublishOnly`.
- `node --expose-gc test/torture.mjs`: `emit` measures 0.000 B/emit over 1,000,000
  emits WITH a 4-deep re-entrant cascade in the measured body; `emitAsync` is a
  PINNED lane that allocates promise machinery by construction (this run 0.885 B/op,
  recorded, never advertised as zero). A soak of 2,000 fresh + 500 dispose + 500
  nested rounds leaves the finalization residual within the ceiling (this run
  `size() 1/16`), `gc major=0 minor=0`. The `DI_ALLOC_BREAK` (per-emit alloc) and
  `DI_TORTURE_BREAK` (whole-suite) controls plus the ASCII-source gate each force a
  non-zero exit.
- `node:test`: 45/45 pass.

### API frozen at 1.0.0
The public surface is exactly the `EventBus` class, `VERSION`, and `OPTIONS`.
Deliberately NOT included -- any would be a post-1.0.0 (1.1) change, never a 1.0.x
slip:
- NOT a dynamic pub/sub emitter -- there is no runtime add/remove; the topology is
  static and boot-locked. For loose listeners, use a plain `EventEmitter`.
- NOT a scheduler -- no queue, no microtask hop, no retries, no backpressure; `emit`
  is a direct synchronous fan-out in registration order.
- NOT the container -- wiring, lifetimes, and teardown live in
  `@zakkster/lite-di-container` (peer).
- Re-entrant `emit` stays bounded at MAX_DEPTH 8 (fail closed), and `emitAsync`
  stays PINNED (allocates by construction; never gated at 0).

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

[1.0.0]: https://www.npmjs.com/package/@zakkster/lite-di-event-bus
[1.0.0-alpha.1]: https://www.npmjs.com/package/@zakkster/lite-di-event-bus
