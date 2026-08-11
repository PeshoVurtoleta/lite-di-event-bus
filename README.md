# @zakkster/lite-di-event-bus

> DI-constructed static event handlers under a boot-locked `multi` topology, dispatched by index over one bus-owned buffer. Listeners are classes the container builds and owns; emit routes through the container so it fails closed after shutdown. Synchronous emit allocates 0 bytes/emit -- hard-gated.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-di-event-bus.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-di-event-bus)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-emit-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-di-event-bus?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-di-event-bus)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-di-event-bus?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-event-bus)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-di-event-bus?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-event-bus)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The event bus the DI ecosystem was missing

`@zakkster/lite-di-container` already builds, wires, and tears down your object
graph. What it did not have was a way to fan an event out to a set of handlers
that are themselves part of that graph -- handlers with their own injected
dependencies, built once at boot, torn down with everything else. Every plain
`EventEmitter` sits outside the container: its listeners are loose closures the
container never sees, never validates, and never tears down.

`lite-di-event-bus` is that missing piece. Listeners are classes registered under
a `multi` binding; the container constructs and caches them at boot; `emit` fills
one bus-owned buffer via the container's `getAllInto` and dispatches by index.
No private cache to fall stale, no allocation per emit, and -- because emit
routes through the container -- a dispatch after shutdown throws instead of
firing torn-down handlers.

```bash
npm install @zakkster/lite-di-event-bus
```

Peer dependency (not bundled, install it alongside):

```bash
npm install @zakkster/lite-di-container
```

```javascript
import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '@zakkster/lite-di-event-bus';

class Audit { constructor(log) { this.log = log; } handle(e) { this.log.push(e); } }
class Metrics { handle(e) { /* increment a counter */ } }

const c = new Container();
c.value('log', []);

const bus = new EventBus(c);
bus.on('order.placed', Audit, ['log'])   // DI-constructed: Audit gets 'log'
   .on('order.placed', Metrics);
bus.boot();                              // sizes the buffer, boots the container

bus.emit('order.placed', { id: 42 });    // 0 B/emit fan-out, by index

await c.shutdown();
bus.emit('order.placed', { id: 43 });    // throws: Container shut down (fail closed)
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The dispatch model](#the-dispatch-model)
- [API reference](#api-reference)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [Constants](#constants)
- [Record and replay (flight recorder)](#record-and-replay-flight-recorder)
- [Composability with the container](#composability-with-the-container)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

A plain emitter and a DI container solve different halves of the same problem and
never meet. The emitter dispatches, but its listeners are closures registered at
runtime -- outside the container's lifecycle, invisible to boot-time validation,
and leaked when you forget to remove them. The container wires and tears down
your services, but has no fan-out primitive.

The `getAllInto(name, out)` method the container shipped in v2.0.0 -- fill a
caller-owned array with a cached `multi` binding's instances, return the count,
zero allocation -- is exactly the primitive a fan-out needs. This package is the
use case it was built for: a `multi` binding of listener classes, resolved once,
dispatched by array index into a buffer the bus owns.

## What you get

- Listeners that are first-class container citizens: constructed with their own
  injected dependencies, cached at boot, torn down on shutdown.
- A synchronous `emit` that allocates zero bytes -- one buffer fill plus an index
  loop, no guards in the hot body.
- Fail-closed behavior end to end: post-shutdown emit throws, unknown options
  throw with a did-you-mean hint, an unknown event throws through the container.
- A static, boot-locked topology: all registration happens before boot, so the
  emit path has nothing to check at runtime.
- `emitSafe` for isolation and `emitAsync` for awaited handlers, both honest
  about their cost.

## The dispatch model

<details>
<summary>How a single emit turns into an index loop (click to expand)</summary>

Registration is cold and happens before boot. `on(name, Class, deps)` delegates
to `container.multi(name, Class, deps)` and bumps a private per-event counter.
Nothing is constructed yet.

`boot()` walks those counters, finds the largest, and allocates a buffer STACK:
`MAX_DEPTH` (8) buffers, each `new Array(max)`. One buffer per synchronous
nesting level. Because every buffer is sized to the largest listener set, the
`RangeError` branch inside `getAllInto` (out shorter than the binding) is
unreachable at emit time, at any depth -- the failure is designed out, not
caught. `boot()` then boots the container if it is not already booted, which
constructs and caches every listener instance under every `multi` binding.

`emit(name, payload)` is then, in full:

```javascript
emit(eventName, payload) {
    if (this._container === null) throw new Error(DISPOSED);
    const d = this._depth;
    if (d >= MAX_DEPTH) throw new Error('[EventBus] emit nesting too deep (max 8)');
    const buf = this._bufStack[this._depth++];
    const n = this._container.getAllInto(eventName, buf);
    try {
        for (let i = 0; i < n; i++) buf[i].handle(payload);
    } finally {
        this._depth = d;
    }
}
```

One `getAllInto` call (which on a fully-cached `multi` copies cached references
into this level's `buf` and returns the count -- zero allocation) and an index
loop. The only guards are two cheap field compares (disposed state, nesting
depth); there is no `has()` pre-gate and no private cache. A listener that
synchronously emits another event takes the NEXT stack buffer (`_depth` is
already incremented), so the outer loop's buffer is never overwritten -- nested
emit stays zero-alloc and correct. The `try/finally` restores `_depth` even if a
handler throws. A post-shutdown emit throws (the container rejects reads once
shut down) rather than silently dispatch to torn-down instances; a cascade deeper
than 8 levels throws `emit nesting too deep (max 8)` (fail-closed runaway guard).

</details>

## API reference

### Constructor

```typescript
new EventBus(container: Container, options?: { onError?: OnError })
```

`options.onError` is the only valid key (used by `emitSafe` and `emitAsync`); it
defaults to a `console.error` reporter. An unknown key throws with a
case-insensitive 3-char-prefix did-you-mean hint
(`Unknown option 'onErr'. Did you mean 'onError'?`). A non-function `onError` is a
`TypeError`. A null/undefined container is a `TypeError`.

### Methods

```typescript
on(eventName: string, ListenerClass: ListenerClass, deps?: string[]): this
boot(): this
emit(eventName: string, payload?: unknown): void
emitSafe(eventName: string, payload?: unknown): void
emitAsync(eventName: string, payload?: unknown): Promise<void>
listenerCount(eventName: string): number
```

- `on` -- pre-boot registration only; delegates to `container.multi`. After the
  container is booted it throws a static topology violation. Chainable.
- `boot` -- allocates the buffer stack (8 buffers, each sized to the largest
  listener count), then boots the container if needed. Idempotent.
- `emit` -- synchronous fan-out by index. 0 B/emit at any nesting depth. No
  pre-gate: post-shutdown throws, unknown event throws through the container. A
  listener may synchronously emit another event; nested cascades are supported to
  depth 8, and a cascade deeper than that throws `emit nesting too deep (max 8)`.
- `emitSafe` -- isolates each listener; a thrown handler goes to `onError` and
  dispatch continues. Same depth-bounded nesting as `emit`.
- `emitAsync` -- awaits each listener in registration order. Reuses the sync
  buffer; do not re-enter `emit*` from an awaited handler.
- `listenerCount` -- registered listener count for an event (0 if none).

### Constants

| Export    | Type               | Meaning                                            |
| --------- | ------------------ | -------------------------------------------------- |
| `VERSION` | `string`           | Three-place-synced version (`1.1.0`).      |
| `OPTIONS` | `readonly string[]`| Frozen `['onError']` -- the only valid option keys.|

## Record and replay (flight recorder)

Added in 1.1.0. An opt-in, bounded tape that captures every emitted
`(name, payload)` and can synchronously re-drive them back through `emit`. It is a
**passive recorder, not a scheduler**: it records what already fired in the same
frame, and `replay()` is a direct synchronous re-drive -- no queue, no microtask, no
timer, no retries. Recording is a runtime method, not a constructor option, so the
three exports and the frozen `OPTIONS` are unchanged.

```typescript
record(capacity: number, opts?: { onOverflow?: 'drop-oldest' | 'throw' }): this
stopRecording(): this
replay(): number
recorded(): number
dropped(): number
clearTape(): this
```

- `record` -- begin capturing into a FIXED ring of exactly `capacity` slots,
  allocated once. `onOverflow` is the full-ring policy: `'drop-oldest'` (default --
  flight-recorder semantics: keep the most recent `capacity` events, rotate, and make
  loss visible via `dropped()`) or `'throw'` (exact-capture: the `capacity+1`-th emit
  throws inside `emit`; the bus stays usable). Fails closed -- disposed bus throws; a
  non-integer or `<= 0` capacity throws naming it; an unknown option throws with a
  did-you-mean hint; a second `record()` while already recording throws.
- `stopRecording` -- halt capture but RETAIN the tape and captured payloads so
  `replay()` still works. Idempotent.
- `replay` -- synchronously re-drive every recorded entry through `emit()` in capture
  order and return the count. Recording is suspended for the duration (a latch,
  restored in `finally`) so the re-drive never self-records. An empty or
  never-recorded tape returns `0`. Disposed bus throws; a re-entrant `replay()`
  throws.
- `recorded` / `dropped` -- entries currently held (never exceeds `capacity`) and
  entries overwritten under `'drop-oldest'` (loss is VISIBLE via a counter, never a
  silent drop; always `0` under `'throw'`).
- `clearTape` -- release every retained payload reference (null the ring slots so a
  `WeakRef` to a recorded payload becomes collectable) and reset head/count/dropped.
  The ring arrays are REUSED. Idempotent; recording continues if active. `dispose()`
  also nulls the tape, so it never outlives the bus.

```javascript
const bus = new EventBus(c);
bus.on('order.placed', Audit, ['log']).boot();

bus.record(1024);                          // ring of 1024, drop-oldest by default
bus.emit('order.placed', { id: 1 });
bus.emit('order.placed', { id: 2 });
bus.stopRecording();                       // keeps the tape for replay

bus.recorded();                            // 2
bus.replay();                              // re-drives both through emit(), returns 2
bus.clearTape();                           // releases the captured payloads
```

## Composability with the container

A full pipeline: values and singletons wired in the container, listeners fanned
out by the bus, reverse-order teardown at the end.

```javascript
import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '@zakkster/lite-di-event-bus';

class Clock { now() { return Date.now(); } }
class Audit {
  constructor(clock, sink) { this.clock = clock; this.sink = sink; }
  handle(event) { this.sink.push({ at: this.clock.now(), event }); }
}
class Metrics {
  constructor(sink) { this.sink = sink; }
  handle() { this.sink.push('metric'); }
}

const c = new Container();
c.singleton('clock', Clock);
c.value('sink', []);

const bus = new EventBus(c, { onError: (e) => { /* report */ } });
bus.on('order.placed', Audit, ['clock', 'sink'])
   .on('order.placed', Metrics, ['sink']);
bus.boot();

bus.emit('order.placed', { id: 1 });      // hot path: 0 B/emit
bus.emitSafe('order.placed', { id: 2 });  // isolated: a thrower will not stop the rest

await c.shutdown();                        // tears down Clock/Audit/Metrics in reverse order
```

## Zero-GC design notes

<details>
<summary>Per-lane allocation, measured and gated (click to expand)</summary>

The synchronous emit path is the whole point of the package, so it is gated at
exactly zero -- not "small", zero -- two independent ways in `test/torture.mjs`:
`measureAllocs` at `maxBytesPerCall: 0` (retained bytes, forced collection) and
`measureOps(stabilize: 'deep')` over 1,000,000 emits with `checkNoGc(maxMajor: 0)`
(no major GC, no ArrayBuffer growth). Crucially, the measured body drives a
4-DEEP nested cascade, so the per-depth buffer push/pop and the `try/finally` are
inside the gated path: emit stays 0.000 B/emit at nesting depth, not just at the
top level. `emitAsync` is the honest boundary: awaiting allocates promise
machinery by construction, so its rate is RECORDED and loosely pinned, never
claimed to be zero.

| Lane                          | Allocation      | How it is gated                          |
| ----------------------------- | --------------- | ---------------------------------------- |
| `emit` (booted, cached)       | 0.000 B/emit    | HARD gate at 0 over 1e6 emits, maxMajor 0 |
| `emit` (4-deep nested cascade)| 0.000 B/emit    | same gate, measured body cascades 4 deep |
| `emit` (recorder ON)          | 0.000 B/emit    | separate 0-B lane: pure ref stores into the ring |
| `emitAsync`                   | ~0.8 B/op       | PINNED (recorded, not gated at zero)     |

What makes 0 B/emit possible: the container owns the listener instances (no
buffer of instances to build per emit), `getAllInto` copies cached references
into the pre-allocated stack buffer for the current depth (no result array), and
the emit body carries only two cheap field-compare guards (disposed, depth) plus
a `try/finally` that mutates one integer. The buffer STACK is allocated once at
boot (8 buffers, each sized to the largest listener count), so a nested emit takes
the next buffer instead of allocating one, and `getAllInto` never needs its
`RangeError` branch at any depth. A cascade past depth 8 throws (fail closed)
rather than allocating unbounded stack.

The 1.1.0 flight recorder is release-guarded to preserve this: with the recorder
off (the default), the hot path adds exactly one `this._tape === null` field compare
and still measures 0.000 B/emit. Recorder ON is a SEPARATE 0-B lane -- capture is
pure reference stores into the ring allocated once by `record()`, never a per-emit
allocation. One nuance worth knowing: `_tape === null` is the pure single-compare
path (never recorded, or after `dispose()`); once a tape exists, `stopRecording()`
and `clearTape()` leave `_tape` non-null, so `emit` pays a `_capture` call that
early-returns at still-0-B rather than the bare compare. That is by design --
retaining the tape is what lets `replay()` work after `stopRecording()` -- and only
`dispose()` restores the pure single-compare. No allocation on either path.

Numbers reproduce with `node --expose-gc test/torture.mjs` (gated by
`@zakkster/lite-gc-profiler`; retention proven by `@zakkster/lite-leak`).

</details>

## Design decisions worth knowing

- **No `has()` pre-gate on emit.** Routing straight through `getAllInto` is what
  makes a post-shutdown emit throw (fail closed) and keeps the body allocation-
  free. A pre-gate would both cost bytes and hide the shutdown.
- **No private listener cache.** The container is the single source of truth for
  the instances. A private cache could dispatch to torn-down objects; dropping it
  is a correctness fix, not just an allocation one.
- **Static, boot-locked topology.** `on()` is pre-boot only. That constraint is
  what lets the emit path carry only two integer-cheap guards: nothing can change
  after boot.
- **Bounded synchronous nesting via a buffer stack.** A listener may emit another
  event synchronously; each level takes the next of 8 pre-allocated buffers, so
  re-entrant emit is correct AND zero-alloc. Depth is capped at 8 (a runaway
  recursion throws rather than growing the stack unbounded), and a `try/finally`
  restores the depth after any handler throw.
- **Fail closed on configuration.** The only option key is `onError`; anything
  else throws with a did-you-mean hint. There is no silent-ignore default.
- **`emitAsync` snapshots, then releases its stack slot before awaiting.** It
  holds a stack buffer only for the synchronous fill, copies the resolved
  listeners into a fresh local, and restores the depth before the first await --
  so overlapping async emits never corrupt each other. That snapshot is why the
  async lane allocates and is never advertised as zero-GC.

## Testing

- `npm test` -- 88 `node:test` cases (behavioural coverage, incl. the record/replay
  boundary suite `test/EventBus.record-replay.test.js`).
- `npm run torture` -- `node --expose-gc test/torture.mjs`: T0 dispatch laws, T3
  lifecycle + record/replay contract (capture order/identity, no-self-record,
  re-entrant-replay throw, empty-returns-0), T5 fuzz (32 seeds x 2000 iters), T6 the
  0 B/emit gate (1e6 emits) with the recorder-ON lane also at 0.000 B/emit + the
  async lane, T7 soak (2000 cycles + 500 record rounds, lite-leak retention incl. a
  WeakRef-to-cleared-payload collectability proof + heap bound), T9 controls (each
  gate proven able to fail: `DI_ASCII_BREAK`, `DI_ALLOC_BREAK`, `DI_TORTURE_BREAK`).
- `npm run example` -- [`examples/order-pipeline.mjs`](examples/order-pipeline.mjs): a
  shipped, self-verifying reference consumer. An order-processing fan-out with
  DI-constructed listeners, a nested emit (`order.placed` -> a handler emits
  `email.queued`), error-isolated `emitSafe`, `emitAsync`, `listenerCount`, `dispose`,
  and the fail-closed paths (on()-after-boot, unknown event, unknown option, non-function
  onError, null container, post-shutdown emit, the distinct post-dispose emit, and the
  depth-8 runaway guard). Every claim is asserted with `node:assert`, so a broken
  contract exits non-zero. It is the downstream proof that the shipped API works in anger.
- `npm run verify` -- all three, in order. `prepublishOnly` runs `verify`.

## What this is not

- Not a dynamic pub/sub emitter. There is no runtime add/remove; the topology is
  static and boot-locked by design. For loose listeners, use a plain
  `EventEmitter`.
- Not a scheduler. No queue, no microtask hop, no retries, no backpressure; emit
  is a direct synchronous fan-out in registration order. The 1.1.0 flight recorder
  keeps this line: it is a passive tape, and `replay()` is a synchronous re-drive
  through `emit`, not deferred or reordered delivery.
- Not the container. Wiring, lifetimes, scopes, and teardown live in
  `@zakkster/lite-di-container` (the peer dependency).

## Ecosystem

- `@zakkster/lite-di-container` -- the DI container this bus is built on (peer
  dependency).
- `@zakkster/lite-gc-profiler` -- the allocation/GC gate used to prove 0 B/emit.
- `@zakkster/lite-leak` -- the retention witness used in the soak tier.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
