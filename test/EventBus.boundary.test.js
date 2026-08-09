// @zakkster/lite-di-event-bus -- QA boundary suite.
// Final-gate coverage: entry-point boundary matrix (0, 1, N-1, N, N+1, empty,
// null, undefined, NaN, -0, duplicate dispose, dispose-during-iteration,
// re-entrant write, and one adversarial case), plus the assertions the planner
// called out by name (A1-A6, S1). The allocation/retention gates live in
// test/torture.mjs; this file is pure node:test behavioural verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '../EventBus.js';

// ===========================================================================
// Boundary matrix -- listener-count / shared-buffer sizing: 0, 1, N-1, N, N+1
// ===========================================================================

test('boundary[0]: an event with zero registrations reports count 0 and falls through to a container throw', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('known', L);
    bus.boot();
    assert.equal(bus.listenerCount('never-registered'), 0);
    // Locked behaviour: emit on a booted-but-never-registered event THROWS
    // (falls through to the container's "not registered" error) -- it does not
    // silently 0-dispatch.
    assert.throws(() => bus.emit('never-registered', 1), /not registered|available/i);
});

test('boundary[1]: a single-listener event dispatches exactly once, buffer sized to 1', () => {
    const c = new Container();
    const bus = new EventBus(c);
    let calls = 0;
    class L { handle() { calls++; } }
    bus.on('solo', L);
    bus.boot();
    assert.equal(bus._bufStack[0].length, 1);
    bus.emit('solo', 1);
    assert.equal(calls, 1);
});

test('boundary[N-1]: an event below the shared-buffer max does not dispatch a stale tail', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class Big1 { handle(p) { log.push('big1/' + p); } }
    class Big2 { handle(p) { log.push('big2/' + p); } }
    class Big3 { handle(p) { log.push('big3/' + p); } }
    class Small1 { handle(p) { log.push('small1/' + p); } }
    bus.on('big', Big1).on('big', Big2).on('big', Big3); // N == 3, sizes the buffer
    bus.on('small', Small1);                              // N-1 == 1, below max
    bus.boot();
    assert.equal(bus._bufStack[0].length, 3);

    bus.emit('big', 'B');                 // fills buf[0..2]
    log.length = 0;
    bus.emit('small', 'S');               // only buf[0] is live; buf[1..2] are stale
    assert.deepEqual(log, ['small1/S'], 'stale tail entries from the prior larger emit must not fire');
});

test('boundary[N]: an event exactly at the shared-buffer max is an exact-fit dispatch', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class L1 { handle(p) { log.push('1/' + p); } }
    class L2 { handle(p) { log.push('2/' + p); } }
    class L3 { handle(p) { log.push('3/' + p); } }
    bus.on('e', L1).on('e', L2).on('e', L3);
    bus.boot();
    assert.equal(bus._bufStack[0].length, 3, 'buffer is sized to exactly N, the only registered event');
    bus.emit('e', 'X');
    assert.deepEqual(log, ['1/X', '2/X', '3/X']);
});

test('boundary[N+1]: exceeding the shared buffer is structurally unreachable post-boot', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    const names = ['a', 'b', 'c'];
    const counts = [2, 5, 1];
    for (let e = 0; e < names.length; e++) {
        for (let i = 0; i < counts[e]; i++) bus.on(names[e], L);
    }
    bus.boot();
    // Invariant: no event's listenerCount can ever exceed the shared buffer's
    // length, for every event registered before boot -- boot() sizes each stack buffer to
    // the largest count, so an N+1 overrun is unreachable through the public
    // API. Registering more after boot throws (topology lock), so there is no
    // way to grow past the sized buffer once booted.
    for (const name of names) {
        assert.ok(bus.listenerCount(name) <= bus._bufStack[0].length,
            `listenerCount('${name}')=${bus.listenerCount(name)} must be <= buf.length=${bus._bufStack[0].length}`);
    }
    assert.throws(() => bus.on('a', L), /after boot|topology/i,
        'registration after boot is refused, so the buffer can never be undersized retroactively');
});

// ===========================================================================
// Boundary matrix -- token policy: '', null, undefined, NaN, -0 as event names
// ===========================================================================

test('boundary[token]: empty-string event name is rejected (delegated to container token policy)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    assert.throws(() => bus.on('', L), TypeError);
});

test('boundary[token]: null event name is rejected', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    assert.throws(() => bus.on(null, L), TypeError);
});

test('boundary[token]: undefined event name is rejected', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    assert.throws(() => bus.on(undefined, L), TypeError);
});

test('boundary[token]: NaN event name is rejected', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    assert.throws(() => bus.on(NaN, L), TypeError);
});

test('boundary[token]: -0 event name is rejected', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    assert.throws(() => bus.on(-0, L), TypeError);
});

test('boundary[token]: a symbol event name is accepted end to end (on -> boot -> emit)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const EV = Symbol('event');
    let calls = 0;
    class L { handle() { calls++; } }
    bus.on(EV, L);
    bus.boot();
    bus.emit(EV, 1);
    assert.equal(calls, 1);
    assert.equal(bus.listenerCount(EV), 1);
});

test('boundary[token]: same-text distinct symbols never collide with a string event name', () => {
    const c = new Container();
    const bus = new EventBus(c);
    let strCalls = 0;
    let symCalls = 0;
    class S { handle() { strCalls++; } }
    class Y { handle() { symCalls++; } }
    bus.on('dup', S);
    bus.on(Symbol('dup'), Y);
    bus.boot();
    bus.emit('dup', 1);
    assert.equal(strCalls, 1);
    assert.equal(symCalls, 0, 'a symbol with the same visible text must not answer the string-keyed emit');
});

// ===========================================================================
// Boundary matrix -- dispose: duplicate dispose, dispose-during-iteration
// ===========================================================================

test('boundary[dispose]: duplicate dispose() is a safe no-op', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.dispose();
    assert.equal(bus._bufStack, null);
    assert.equal(bus._container, null);
    assert.doesNotThrow(() => bus.dispose());
    // State stays released, not re-thrown or re-initialised.
    assert.equal(bus._bufStack, null);
    assert.equal(bus._container, null);
    assert.equal(bus._counts, null);
    assert.equal(bus._onError, null);
});

test('boundary[dispose]: dispose() called from within an in-flight emit does not retroactively cancel that dispatch', () => {
    // dispose() reassigns this._bufStack/this._container to null; it does not mutate
    // the array object already captured as a local `buf` inside emit()'s frame.
    // Locking the OBSERVED behaviour: the in-flight dispatch runs to completion
    // on its stale local reference, and only the NEXT call to any guarded method
    // sees the disposed state.
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class A { handle() { log.push('a'); bus.dispose(); } }
    class B { handle() { log.push('b'); } }
    bus.on('e', A).on('e', B);
    bus.boot();
    assert.doesNotThrow(() => bus.emit('e', 1));
    assert.deepEqual(log, ['a', 'b'], 'the in-flight dispatch must finish even though dispose() ran mid-loop');
    assert.equal(bus._bufStack, null);
    assert.equal(bus._container, null);
    assert.throws(() => bus.emit('e', 2), /disposed/);
});

test('boundary[dispose]: full fail-closed surface after dispose()', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.dispose();
    assert.throws(() => bus.on('e', L), /disposed/);
    assert.throws(() => bus.boot(), /disposed/);
    assert.throws(() => bus.listenerCount('e'), /disposed/);
    assert.throws(() => bus.emit('e', 1), /disposed/);
    assert.throws(() => bus.emitSafe('e', 1), /disposed/);
    await assert.rejects(() => bus.emitAsync('e', 1), /disposed/);
});

// ===========================================================================
// shutdown() (container) vs dispose() (bus): distinct messages, not conflated
// ===========================================================================

test('boundary: post-shutdown throw and post-dispose throw carry distinct, non-overlapping messages', async () => {
    // Lane 1: container shutdown -- bus is still "live" (not disposed), so the
    // message must be the container's own /shut down/ wording, and must NOT
    // also satisfy /disposed/.
    const c1 = new Container();
    const bus1 = new EventBus(c1);
    class L { handle() {} }
    bus1.on('e', L);
    bus1.boot();
    await c1.shutdown();
    let shutdownMsg = '';
    try { bus1.emit('e', 1); } catch (e) { shutdownMsg = e.message; }
    assert.match(shutdownMsg, /shut down/i);
    assert.doesNotMatch(shutdownMsg, /disposed/i, 'a shutdown-path throw must not read as a disposed-path throw');

    // Lane 2: bus dispose -- must be the bus's own /disposed/ wording, and must
    // NOT also satisfy /shut down/.
    const c2 = new Container();
    const bus2 = new EventBus(c2);
    bus2.on('e', L);
    bus2.boot();
    bus2.dispose();
    let disposeMsg = '';
    try { bus2.emit('e', 1); } catch (e) { disposeMsg = e.message; }
    assert.match(disposeMsg, /disposed/i);
    assert.doesNotMatch(disposeMsg, /shut down/i, 'a disposed-path throw must not read as a shutdown-path throw');
});

// ===========================================================================
// emitSafe: a throwing listener AND a throwing onError -- must not vanish
// ===========================================================================

test('emitSafe: a throwing onError itself is not silently swallowed', () => {
    const c = new Container();
    const bus = new EventBus(c, {
        onError() { throw new Error('onError itself blew up'); },
    });
    class Boom { handle() { throw new Error('listener boom'); } }
    bus.on('e', Boom);
    bus.boot();
    // The onError throw must surface out of emitSafe, not vanish into a
    // swallowed catch -- emitSafe isolates LISTENER failures, not onError's own.
    assert.throws(() => bus.emitSafe('e', 1), /onError itself blew up/);
});

// ===========================================================================
// getAllInto buffer boundary: exact-fit event and one-below-max event
// ===========================================================================

test('getAllInto buffer boundary: exact-fit count and one-below-max count both dispatch correctly with no cross-talk', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class Max1 { handle(p) { log.push('max1/' + p); } }
    class Max2 { handle(p) { log.push('max2/' + p); } }
    class Max3 { handle(p) { log.push('max3/' + p); } }
    class Min1 { handle(p) { log.push('min1/' + p); } }
    class Min2 { handle(p) { log.push('min2/' + p); } }
    bus.on('max', Max1).on('max', Max2).on('max', Max3); // == max (exact fit)
    bus.on('min', Min1).on('min', Min2);                 // one below max
    bus.boot();
    assert.equal(bus._bufStack[0].length, 3);

    bus.emit('max', 'M');
    assert.deepEqual(log, ['max1/M', 'max2/M', 'max3/M']);

    log.length = 0;
    bus.emit('min', 'N');
    assert.deepEqual(log, ['min1/N', 'min2/N'], 'exactly two dispatches, no stale third from the exact-fit emit');
});

// ===========================================================================
// Re-entrant write / adversarial: nested synchronous emit() on the shared buffer
// ===========================================================================

test('re-entrant write: on() is refused even when attempted from inside an in-flight emit', () => {
    // Static topology is boot-locked; even a re-entrant registration attempt
    // triggered synchronously from within a listener must still fail closed.
    const c = new Container();
    const bus = new EventBus(c);
    let caught = null;
    class L {
        handle() {
            class M { handle() {} }
            try { bus.on('e', M); } catch (e) { caught = e; }
        }
    }
    bus.on('e', L);
    bus.boot();
    bus.emit('e', 1);
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /after boot|topology/i);
});

test('ADVERSARIAL: a nested synchronous emit() from within a listener does not corrupt dispatch (D-EB-REENTRANT)', () => {
    // Regression for the buffer-stack fix. Previously the bus owned ONE shared
    // buffer array reused by every event, and emit() walked it in place; a
    // listener that synchronously emitted a DIFFERENT event let the inner
    // getAllInto overwrite slots the outer loop had not yet visited -- the outer
    // dispatch then called .handle() on the WRONG event's instances, and the
    // outer listener in that slot never fired (observed [outer1, inner1, inner2,
    // inner2]: Outer2 dropped, Inner2 doubled).
    //
    // The fix: a depth-indexed buffer STACK. Each nested emit takes the NEXT
    // stack buffer, so the outer loop's buffer is never overwritten. This mirrors
    // the S1 guarantee already enforced for emitAsync.
    //
    // Locked expectation: every listener of BOTH events fires EXACTLY ONCE, each
    // with its OWN event's payload.
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class Outer1 { handle(p) { log.push('outer1/' + p); bus.emit('inner', 'IN'); } }
    class Outer2 { handle(p) { log.push('outer2/' + p); } }
    class Inner1 { handle(p) { log.push('inner1/' + p); } }
    class Inner2 { handle(p) { log.push('inner2/' + p); } }
    bus.on('outer', Outer1).on('outer', Outer2); // 2 listeners
    bus.on('inner', Inner1).on('inner', Inner2); // 2 listeners -- shares the size-2 buffer
    bus.boot();

    bus.emit('outer', 'OUT');

    const count = (v) => log.filter((x) => x === v).length;
    assert.equal(count('outer1/OUT'), 1, 'outer1 fires once with OUT');
    assert.equal(count('outer2/OUT'), 1, 'outer2 fires once with OUT -- its stack slot is not overwritten by the nested emit');
    assert.equal(count('inner1/IN'), 1, 'inner1 fires once with IN');
    assert.equal(count('inner2/IN'), 1, 'inner2 fires once with IN');
    assert.equal(log.length, 4, 'exactly four dispatches total, no doubles, no drops');
    // Exact order the buffer stack produces.
    assert.deepEqual(log, ['outer1/OUT', 'inner1/IN', 'inner2/IN', 'outer2/OUT']);
    assert.equal(bus._depth, 0, 'depth restored to 0 after the cascade');
});

// ===========================================================================
// Nesting depth: cap enforcement (fail-closed + recoverable) and depth restore
// ===========================================================================

test('nesting[cap]: a cascade past MAX_DEPTH throws /nesting too deep/, then recovers', () => {
    const c = new Container();
    const bus = new EventBus(c);
    c.value('bus', bus);
    for (let k = 0; k < 8; k++) {
        const next = 'lvl' + (k + 1);
        class L { constructor(b) { this.bus = b; } handle(p) { this.bus.emit(next, p); } }
        bus.on('lvl' + k, L, ['bus']);
    }
    class Leaf { handle() {} }
    bus.on('lvl8', Leaf); // reached only at depth 8 -> throws
    let safeCalls = 0;
    class Safe { handle() { safeCalls++; } }
    bus.on('safe', Safe);
    bus.boot();

    assert.throws(() => bus.emit('lvl0', 1), /nesting too deep/);
    assert.equal(bus._depth, 0, 'depth restored to 0 after the deep throw');
    // Recoverable: the next top-level emit on a separate event dispatches.
    bus.emit('safe', 1);
    assert.equal(safeCalls, 1);
    assert.equal(bus._depth, 0);
});

test('nesting[depth-restore]: a throwing listener leaves _depth === 0 (finally restored)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class Boom { handle() { throw new Error('listener boom'); } }
    bus.on('e', Boom);
    bus.boot();
    assert.throws(() => bus.emit('e', 1), /listener boom/);
    assert.equal(bus._depth, 0, 'finally restored depth after a handler throw');
    // Still usable.
    assert.throws(() => bus.emit('e', 1), /listener boom/);
    assert.equal(bus._depth, 0);
});

test('depth-invariant[unknown-event]: getAllInto-throw on emit does not leak _depth, 8x does not brick', () => {
    // Regression for the S1 depth leak: the getAllInto fill sat outside the try,
    // so an unknown-event throw (originating INSIDE getAllInto) skipped the
    // finally and leaked _depth +1 each time -- at 8 a VALID emit bricked with
    // "nesting too deep". Both increment and fill are now inside the try.
    const c = new Container();
    const bus = new EventBus(c);
    let calls = 0;
    class L { handle() { calls++; } }
    bus.on('e', L);
    bus.boot();
    for (let i = 0; i < 8; i++) {
        assert.throws(() => bus.emit('unknown', 1), /not registered|available/i);
        assert.equal(bus._depth, 0, `emit _depth leaked after unknown-event throw #${i}`);
    }
    // The load-bearing assertion: a valid emit after 8 fail-closed throws still fires.
    bus.emit('e', 1);
    assert.equal(calls, 1, 'valid emit after 8 unknown-event throws must still dispatch (not bricked)');
    assert.equal(bus._depth, 0);
});

test('depth-invariant[unknown-event]: getAllInto-throw on emitSafe does not leak _depth, 8x does not brick', () => {
    const c = new Container();
    const bus = new EventBus(c);
    let calls = 0;
    class L { handle() { calls++; } }
    bus.on('e', L);
    bus.boot();
    for (let i = 0; i < 8; i++) {
        assert.throws(() => bus.emitSafe('unknown', 1), /not registered|available/i);
        assert.equal(bus._depth, 0, `emitSafe _depth leaked after unknown-event throw #${i}`);
    }
    bus.emitSafe('e', 1);
    assert.equal(calls, 1, 'valid emitSafe after 8 unknown-event throws must still dispatch');
    assert.equal(bus._depth, 0);
});

test('depth-invariant[post-shutdown]: getAllInto-throw after shutdown leaves _depth === 0', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    await c.shutdown();
    assert.throws(() => bus.emit('e', 1), /shut down/i);
    assert.equal(bus._depth, 0, 'emit _depth leaked after a post-shutdown throw');
    assert.throws(() => bus.emitSafe('e', 1), /shut down/i);
    assert.equal(bus._depth, 0, 'emitSafe _depth leaked after a post-shutdown throw');
});

test('depth-invariant[guard-throw]: the depth-9 guard throw leaves _depth === 0', () => {
    const c = new Container();
    const bus = new EventBus(c);
    c.value('bus', bus);
    for (let k = 0; k < 8; k++) {
        const next = 'lvl' + (k + 1);
        class L { constructor(b) { this.bus = b; } handle(p) { this.bus.emit(next, p); } }
        bus.on('lvl' + k, L, ['bus']);
    }
    class Leaf { handle() {} }
    bus.on('lvl8', Leaf);
    bus.boot();
    assert.throws(() => bus.emit('lvl0', 1), /nesting too deep/);
    assert.equal(bus._depth, 0, 'guard-throw path restored depth to 0');
});

// ===========================================================================
// A synchronous emit() interleaved during an in-flight emitAsync() await must
// not alias buffers -- emitAsync releases its stack slot (this._depth reset)
// BEFORE its first await, so a sync emit that runs while the async call is
// suspended takes a fresh slot 0 and cannot see/overwrite the async call's
// already-snapshotted local listener array.
// ===========================================================================

test('overlapping: a sync emit() interleaved during an in-flight emitAsync() await does not alias buffers', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class A1 { async handle(p) { await Promise.resolve(); log.push('a1/' + p); } }
    class A2 { async handle(p) { await Promise.resolve(); log.push('a2/' + p); } }
    class B1 { handle(p) { log.push('b1/' + p); } }
    class B2 { handle(p) { log.push('b2/' + p); } }
    bus.on('a', A1).on('a', A2);
    bus.on('b', B1).on('b', B2);
    bus.boot();

    // Calling emitAsync runs its synchronous prefix (fill + snapshot + depth
    // release) immediately, then suspends at the first await and returns a
    // pending promise -- _depth is already back to 0 at this point.
    const pa = bus.emitAsync('a', 'PA');
    assert.equal(bus._depth, 0, 'emitAsync released its stack slot before the first await');
    // A synchronous emit interleaved right here must dispatch cleanly on a
    // fresh slot 0, with no cross-talk into the still-pending async call.
    bus.emit('b', 'SYNC');
    await pa;

    const count = (v) => log.filter((x) => x === v).length;
    assert.equal(count('b1/SYNC'), 1, 'b1 fired once with SYNC, before the async resumed');
    assert.equal(count('b2/SYNC'), 1, 'b2 fired once with SYNC, before the async resumed');
    assert.equal(count('a1/PA'), 1, 'a1 fired once with PA');
    assert.equal(count('a2/PA'), 1, 'a2 fired once with PA');
    assert.equal(log.length, 4, 'exactly four dispatches, no doubles, no drops');
    assert.deepEqual(log, ['b1/SYNC', 'b2/SYNC', 'a1/PA', 'a2/PA'],
        'the sync emit fully completes before the suspended async call resumes on the microtask queue');
    assert.equal(bus._depth, 0);
});

test('nesting[exact-8]: a cascade exactly MAX_DEPTH deep dispatches with no throw', () => {
    // lvl0..lvl7 (8 levels) -- the deepest emit is lvl7 at depth 7 < 8. The leaf
    // records; no nesting-too-deep throw at the cap boundary.
    const c = new Container();
    const bus = new EventBus(c);
    c.value('bus', bus);
    let leafCalls = 0;
    for (let k = 0; k < 7; k++) {
        const next = 'lvl' + (k + 1);
        class L { constructor(b) { this.bus = b; } handle(p) { this.bus.emit(next, p); } }
        bus.on('lvl' + k, L, ['bus']);
    }
    class Leaf { handle() { leafCalls++; } }
    bus.on('lvl7', Leaf);
    bus.boot();
    assert.doesNotThrow(() => bus.emit('lvl0', 1));
    assert.equal(leafCalls, 1, 'the depth-7 leaf fired exactly once');
    assert.equal(bus._depth, 0);
});
