/**
 * Reference app -- an order-processing fan-out (gate-3 downstream consumer).
 *
 * Proves @zakkster/lite-di-event-bus "in anger": a static, boot-locked listener
 * topology whose handlers are DI-CONSTRUCTED (each gets its own injected deps), with a
 * synchronous zero-alloc fan-out, a nested emit (one handler emits a follow-up event),
 * error-isolated dispatch, and a fail-closed runaway-recursion guard.
 *
 * It exercises the ENTIRE public surface end-to-end, not in fragments:
 *   - new EventBus(container, { onError })   + OPTIONS + VERSION
 *   - on(event, ListenerClass, deps?)        (DI-constructed listeners, chainable)
 *   - boot()                                 (locks the topology, sizes the buffer)
 *   - emit(event, payload)                   (sync fan-out by index, incl. a NESTED emit)
 *   - emitSafe(event, payload)               (a throwing handler -> onError, others run)
 *   - emitAsync(event, payload)              (await each handler in order)
 *   - listenerCount(event)
 *   - dispose()                              (releases bus state; emit* then fail closed)
 *   - the fail-closed contract: on() after boot, an unknown event, an unknown option, a
 *     non-function onError, a null container, a post-shutdown emit (container error), a
 *     post-dispose emit (distinct bus error), and a cascade past depth 8 all throw named
 *     errors instead of degrading silently.
 *
 * It is self-verifying: every claim is asserted with node:assert, so a broken contract
 * exits non-zero. Run it: `npm run example` (or `node examples/order-pipeline.mjs`).
 * ASCII-only; the only imports are the two @zakkster packages and node:assert.
 *
 * NOTE: @zakkster/lite-di-container is a PEER dependency of this package -- install it
 * alongside (`npm i @zakkster/lite-di-container`) to run this example from a tarball.
 */

import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { EventBus, OPTIONS, VERSION } from '@zakkster/lite-di-event-bus';

/** Tiny ASCII logger -- a demo prints, but never from library source. */
const out = (line) => process.stdout.write(line + '\n');

// A test sink, injected into the listeners so we can assert what fanned out and in
// what order. In a real app these are your DB writer, metrics client, mailer, etc.
const sink = { trace: [], errors: [] };

// ---------------------------------------------------------------------------
// The listeners -- plain classes with a handle(payload). Each is DI-constructed
// by the container from its declared deps, exactly like any other binding.
// ---------------------------------------------------------------------------
class Audit { constructor(s) { this.s = s; } handle(e) { this.s.trace.push('audit:' + e.id); } }
class Inventory { constructor(s) { this.s = s; } handle(e) { this.s.trace.push('reserve:' + e.id); } }
/** Reacts to an order by emitting a FOLLOW-UP event -- a nested synchronous emit. */
class Notifier {
    constructor(s, bus) { this.s = s; this.bus = bus; }
    handle(e) { this.s.trace.push('notify:' + e.id); this.bus.emit('email.queued', { to: e.id }); }
}
class EmailQueue { constructor(s) { this.s = s; } handle(p) { this.s.trace.push('email:' + p.to); } }
class Flaky { handle() { throw new Error('report backend down'); } }
class Steady { constructor(s) { this.s = s; } handle() { this.s.trace.push('steady'); } }
class Settle {
    constructor(s) { this.s = s; }
    async handle(e) { await Promise.resolve(); this.s.trace.push('settle:' + e.id); }
}
/** A BUGGY listener that re-emits its own event -- models an accidental cascade. */
class Runaway { constructor(bus) { this.bus = bus; } handle() { this.bus.emit('loop', {}); } }

// ---------------------------------------------------------------------------
// Wire the container + bus. Registration is PRE-BOOT only (static topology).
// The bus itself is injected so a listener can emit a follow-up event.
// ---------------------------------------------------------------------------
const c = new Container();
c.value('sink', sink);
const bus = new EventBus(c, { onError: (err) => sink.errors.push(err.message) });
// Inject the bus so a listener can emit a follow-up event. This forms a bus<->container
// reference; a long-lived consumer releases it by calling bus.dispose() after
// c.shutdown() (demonstrated at the end) -- a script that just exits need not.
c.value('bus', bus);

bus.on('order.placed', Audit, ['sink'])
    .on('order.placed', Inventory, ['sink'])
    .on('order.placed', Notifier, ['sink', 'bus'])
    .on('email.queued', EmailQueue, ['sink'])
    .on('report.run', Flaky)
    .on('report.run', Steady, ['sink'])
    .on('order.settled', Settle, ['sink'])
    .on('loop', Runaway, ['bus']);
bus.boot(); // locks the topology, sizes the buffer stack, boots the container

out('order-pipeline reference app -- @zakkster/lite-di-event-bus v' + VERSION);
assert.ok(Object.isFrozen(OPTIONS), 'OPTIONS must be frozen');
assert.deepEqual([...OPTIONS], ['onError']);
assert.ok(typeof VERSION === 'string' && VERSION.length > 0);

// ---------------------------------------------------------------------------
// 1. Synchronous fan-out, WITH a nested emit. order.placed -> audit, reserve,
//    notify -> (nested) email.queued -> email. Dispatch is by index, in
//    registration order; the nested emit runs on its own buffer.
// ---------------------------------------------------------------------------
sink.trace = [];
bus.emit('order.placed', { id: 42 });
out('\n-- fan-out ----------------------------------------------------------');
out('order.placed(42) -> ' + sink.trace.join(' -> '));
assert.deepEqual(sink.trace, ['audit:42', 'reserve:42', 'notify:42', 'email:42'],
    'sync fan-out runs in registration order, nested emit appended after notify');
assert.equal(bus.listenerCount('order.placed'), 3);
assert.equal(bus.listenerCount('email.queued'), 1);

// ---------------------------------------------------------------------------
// 2. emitSafe -- a throwing handler is routed to onError and dispatch CONTINUES.
//    With plain emit the throw would propagate; emitSafe isolates it per-listener.
// ---------------------------------------------------------------------------
sink.trace = [];
sink.errors = [];
bus.emitSafe('report.run', {});
out('\n-- error isolation (emitSafe) ---------------------------------------');
out('report.run -> onError captured: ' + JSON.stringify(sink.errors) + ', steady still ran: ' +
    sink.trace.includes('steady'));
assert.deepEqual(sink.errors, ['report backend down'], 'the thrown handler was routed to onError');
assert.ok(sink.trace.includes('steady'), 'dispatch continued to the next listener after the throw');

// ---------------------------------------------------------------------------
// 3. emitAsync -- await each handler in registration order.
// ---------------------------------------------------------------------------
sink.trace = [];
await bus.emitAsync('order.settled', { id: 42 });
assert.deepEqual(sink.trace, ['settle:42'], 'emitAsync awaited the async handler');

// ---------------------------------------------------------------------------
// 4. FAIL-CLOSED, proven. Each of these throws a named error rather than
//    silently degrading. A shared helper asserts a real throw.
// ---------------------------------------------------------------------------
const throwsOn = (fn, label) => {
    let e = null;
    try { fn(); } catch (err) { e = err; }
    assert.ok(e instanceof Error, label + ' MUST fail closed (throw)');
    return e;
};

// (a) a runaway cascade fails closed at depth 8, and the bus stays usable after.
const deep = throwsOn(() => bus.emit('loop', {}), 'a cascade past depth 8');
assert.match(deep.message, /nesting too deep/, 'depth guard message names the runaway');
sink.trace = [];
bus.emit('order.placed', { id: 43 }); // still works -- try/finally restored the depth
assert.ok(sink.trace.includes('audit:43'), 'the bus is usable after the depth-guard throw');

// (b) static topology: registering after boot throws.
throwsOn(() => bus.on('late', Audit, ['sink']), 'on() after boot');
// (c) an unknown event falls through to the container's unregistered throw.
const unknownEvent = throwsOn(() => bus.emit('no.such.event', {}), 'an unknown event');
assert.match(unknownEvent.message, /not registered/, 'unknown event throws the container error');
// (d) construction guards: unknown option (with a did-you-mean hint), non-function
//     onError, null container.
const optErr = throwsOn(() => new EventBus(c, { onerror: () => {} }), 'an unknown option key');
assert.match(optErr.message, /Did you mean 'onError'/, 'unknown option offers a did-you-mean hint');
throwsOn(() => new EventBus(c, { onError: 123 }), 'a non-function onError');
throwsOn(() => new EventBus(null), 'a null container');

out('\n-- fail-closed ------------------------------------------------------');
out('depth-8 guard, on()-after-boot, unknown event, unknown option, non-function onError, ' +
    'null container all threw');

// (e) after the container shuts down, emit fails closed (no stale dispatch) with the
//     CONTAINER's error -- the bus holds no listener cache to dispatch from.
await c.shutdown();
const afterShutdown = throwsOn(() => bus.emit('order.placed', { id: 44 }), 'emit after shutdown');
assert.match(afterShutdown.message, /shut down/, 'post-shutdown emit throws the container error');
out('post-shutdown emit threw: ' + afterShutdown.message);

// (f) dispose() releases the bus's own state; afterward emit* fail closed with the
//     DISTINCT bus-disposed error (a separate contract from container shutdown).
bus.dispose();
const afterDispose = throwsOn(() => bus.emit('order.placed', { id: 45 }), 'emit after dispose');
assert.match(afterDispose.message, /has been disposed/, 'post-dispose emit throws the bus error');
out('post-dispose emit threw:  ' + afterDispose.message);

out('\nreference app: OK (every contract asserted)');
