# @zakkster/lite-di-event-bus

> DI-constructed static event handlers under a boot-locked `multi` topology, dispatched by index over one bus-owned buffer. Listeners are classes the container builds and owns; emit routes through the container so it fails closed after shutdown. Synchronous emit allocates 0 bytes/emit -- hard-gated.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-di-event-bus.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-di-event-bus)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-emit-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-di-event-bus?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-di-event-bus)
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

`boot()` walks those counters, finds the largest, and allocates ONE shared buffer
`new Array(max)`. Because the buffer is sized to the largest listener set, the
`RangeError` branch inside `getAllInto` (out shorter than the binding) is
unreachable at emit time -- the failure is designed out, not caught. `boot()`
then boots the container if it is not already booted, which constructs and caches
every listener instance under every `multi` binding.

`emit(name, payload)` is then, in full:

```javascript
emit(eventName, payload) {
    const buf = this._buf;
    const n = this._container.getAllInto(eventName, buf);
    for (let i = 0; i < n; i++) buf[i].handle(payload);
}
```

One property read, one `getAllInto` call (which on a fully-cached `multi` copies
cached references into `buf` and returns the count -- zero allocation), and an
index loop. There is no `has()` pre-gate, no private cache, and no `try/catch` in
the body. That absence is deliberate: it is what keeps the frame optimizable and
0 B/emit, and it is what makes a post-shutdown emit throw (the container rejects
reads once shut down) rather than silently dispatch to torn-down instances.

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
- `boot` -- allocates the shared buffer sized to the largest listener count, then
  boots the container if needed. Idempotent.
- `emit` -- synchronous fan-out by index. 0 B/emit. No pre-gate: post-shutdown
  throws, unknown event throws through the container.
- `emitSafe` -- isolates each listener; a thrown handler goes to `onError` and
  dispatch continues.
- `emitAsync` -- awaits each listener in registration order. Reuses the sync
  buffer; do not re-enter `emit*` from an awaited handler.
- `listenerCount` -- registered listener count for an event (0 if none).

### Constants

| Export    | Type               | Meaning                                            |
| --------- | ------------------ | -------------------------------------------------- |
| `VERSION` | `string`           | Three-place-synced version (`1.0.0-alpha.1`).      |
| `OPTIONS` | `readonly string[]`| Frozen `['onError']` -- the only valid option keys.|

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
(no major GC, no ArrayBuffer growth). `emitAsync` is the honest boundary:
awaiting allocates promise machinery by construction, so its rate is RECORDED and
loosely pinned, never claimed to be zero.

| Lane                         | Allocation      | How it is gated                         |
| ---------------------------- | --------------- | --------------------------------------- |
| `emit` (booted, cached)      | 0.000 B/emit    | HARD gate at 0 over 1e6 emits, maxMajor 0 |
| `emitAsync`                  | ~0.8 B/op       | PINNED (recorded, not gated at zero)    |

What makes 0 B/emit possible: the container owns the listener instances (no
buffer of instances to build per emit), `getAllInto` copies cached references
into the pre-allocated bus buffer (no result array), and the emit body has no
guards, no closures, and no strings. The buffer is allocated once at boot and
sized so `getAllInto` never needs its `RangeError` branch.

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
  what lets the emit path be branchless: nothing can change after boot.
- **Fail closed on configuration.** The only option key is `onError`; anything
  else throws with a did-you-mean hint. There is no silent-ignore default.
- **`emitAsync` reuses the sync buffer.** Cheap and correct for the common case;
  the one rule is not to re-enter `emit*` from inside an awaited handler.

## Testing

- `npm test` -- 15 `node:test` cases (behavioural coverage).
- `npm run torture` -- `node --expose-gc test/torture.mjs`: T0 dispatch laws, T3
  lifecycle, T5 fuzz (32 seeds x 2000 iters), T6 the 0 B/emit gate (1e6 emits) +
  the async lane, T7 soak (2000 cycles, lite-leak retention + heap bound), T9
  controls (each gate proven able to fail: `DI_ASCII_BREAK`, `DI_ALLOC_BREAK`,
  `DI_TORTURE_BREAK`).
- `npm run verify` -- both, in order. `prepublishOnly` runs `verify`.

## What this is not

- Not a dynamic pub/sub emitter. There is no runtime add/remove; the topology is
  static and boot-locked by design. For loose listeners, use a plain
  `EventEmitter`.
- Not a scheduler. No queue, no microtask hop, no retries, no backpressure; emit
  is a direct synchronous fan-out in registration order.
- Not the container. Wiring, lifetimes, scopes, and teardown live in
  `@zakkster/lite-di-container` (the peer dependency).

## Ecosystem

- `@zakkster/lite-di-container` -- the DI container this bus is built on (peer
  dependency).
- `@zakkster/lite-gc-profiler` -- the allocation/GC gate used to prove 0 B/emit.
- `@zakkster/lite-leak` -- the retention witness used in the soak tier.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
