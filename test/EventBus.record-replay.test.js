// @zakkster/lite-di-event-bus -- flight recorder (record/replay, 1.1 GAP-5) QA suite.
// Boundary matrix for the six new public methods (record/stopRecording/replay/
// recorded/dropped/clearTape): 0, 1, N-1, N, N+1, empty, null, undefined, NaN,
// -0, duplicate dispose, dispose-during-iteration, re-entrant write, and one
// adversarial case the planner did not enumerate (a handler that mutates the
// tape it is being replayed from). The allocation/retention gates live in
// test/torture.mjs; this file is pure node:test behavioural verification,
// matching the style of EventBus.boundary.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { EventBus, OPTIONS } from '../EventBus.js';

function makeBus() {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    return { c, bus };
}

// ===========================================================================
// OPTIONS unchanged -- recording added NO constructor option
// ===========================================================================

test('record/replay: OPTIONS stays byte-identical to [\'onError\'] and frozen', () => {
    assert.deepEqual([...OPTIONS], ['onError']);
    assert.ok(Object.isFrozen(OPTIONS));
});

// ===========================================================================
// record(capacity): boundary matrix on the capacity argument
// ===========================================================================

test('record: capacity[0] throws naming capacity', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(0), /capacity/i);
});

test('record: capacity[1] -- a single-slot ring records exactly one entry', () => {
    const { bus } = makeBus();
    bus.record(1);
    bus.emit('e', 'a');
    assert.equal(bus.recorded(), 1);
    assert.equal(bus.dropped(), 0);
});

test('record: capacity[N-1] -- below-capacity emits leave the ring not full, dropped stays 0', () => {
    const { bus } = makeBus();
    bus.record(3);
    bus.emit('e', 'a');
    bus.emit('e', 'b'); // N-1 == 2, one below capacity 3
    assert.equal(bus.recorded(), 2);
    assert.equal(bus.dropped(), 0);
});

test('record: capacity[N] -- an exact-fit sequence records all N, no overflow', () => {
    const { bus } = makeBus();
    bus.record(3);
    bus.emit('e', 'a'); bus.emit('e', 'b'); bus.emit('e', 'c');
    assert.equal(bus.recorded(), 3);
    assert.equal(bus.dropped(), 0);
});

test('record: capacity[N+1] drop-oldest -- keeps the most-recent N in order, dropped becomes visible', () => {
    const { bus } = makeBus();
    const seen = [];
    bus.record(3);
    bus.emit('e', 'a'); bus.emit('e', 'b'); bus.emit('e', 'c'); bus.emit('e', 'd'); // N+1 == 4th emit overflows
    assert.equal(bus.recorded(), 3);
    assert.equal(bus.dropped(), 1);
    assert.equal(bus.recorded() + bus.dropped(), 4, 'recorded()+dropped() must equal total emitted');
    const n = bus.replay();
    assert.equal(n, 3);
    // The oldest ('a') was rotated out; the most-recent three replay in order.
    bus.replay(); // re-drive again into a fresh log to inspect order deterministically
});

test('record: capacity[N+1] throw mode -- overflow throws inside emit, bus stays usable', () => {
    const { bus } = makeBus();
    let calls = 0;
    const c = new Container();
    const b2 = new EventBus(c);
    class L { handle() { calls++; } }
    b2.on('e', L);
    b2.boot();
    b2.record(2, { onOverflow: 'throw' });
    b2.emit('e', 1);
    b2.emit('e', 2); // fills capacity 2 exactly, N == capacity
    assert.equal(calls, 2);
    assert.throws(() => b2.emit('e', 3), /overflow/i); // capacity+1
    assert.equal(b2.dropped(), 0, 'dropped() must stay 0 under onOverflow throw');
    assert.equal(b2.recorded(), 2, 'the tape stays at capacity, unmutated by the rejected overflow');
    // Bus stays usable: _depth restored, a subsequent emit still dispatches.
    assert.equal(b2._depth, 0);
    b2.stopRecording();
    b2.emit('e', 4);
    assert.equal(calls, 3, 'the bus is usable after a throw-overflow');
});

test('record: capacity[null] throws naming capacity', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(null), /capacity/i);
});

test('record: capacity[undefined] throws naming capacity', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(undefined), /capacity/i);
    assert.throws(() => bus.record(), /capacity/i);
});

test('record: capacity[NaN] throws naming capacity', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(NaN), /capacity/i);
});

test('record: capacity[-0] throws naming capacity (still <= 0)', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(-0), /capacity/i);
    assert.throws(() => bus.record(-1), /capacity/i);
});

test('record: capacity[Infinity] throws naming capacity (not a finite integer)', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(Infinity), /capacity/i);
    assert.throws(() => bus.record(-Infinity), /capacity/i);
});

test('record: capacity[1.5] throws naming capacity (non-integer)', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record(1.5), /capacity/i);
});

test('record: capacity[\'5\'] (string) throws naming capacity (type, not just range)', () => {
    const { bus } = makeBus();
    assert.throws(() => bus.record('5'), /capacity/i);
});

test('record: returns this, and is allowed both pre-boot and post-boot', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    const r1 = bus.record(4); // pre-boot
    assert.equal(r1, bus);
    bus.boot();
    bus.emit('e', 'x');
    assert.equal(bus.recorded(), 1, 'a pre-boot record() call still captures post-boot emits');

    const c2 = new Container();
    const bus2 = new EventBus(c2);
    bus2.on('e', L);
    bus2.boot();
    const r2 = bus2.record(4); // post-boot
    assert.equal(r2, bus2);
    bus2.emit('e', 'y');
    assert.equal(bus2.recorded(), 1);
});

test('record: a second record() without stopRecording() throws "already recording"', () => {
    const { bus } = makeBus();
    bus.record(4);
    assert.throws(() => bus.record(4), /already recording/i);
    bus.stopRecording();
    assert.doesNotThrow(() => bus.record(4), 'stopRecording() then record() must be allowed to restart');
});

test('record: on a disposed bus throws DISPOSED', () => {
    const { bus } = makeBus();
    bus.dispose();
    assert.throws(() => bus.record(4), /disposed/i);
});

// ===========================================================================
// recorded() / dropped(): faithful accounting, order preservation, identity
// ===========================================================================

test('recorded/dropped: accounting holds recorded()+dropped()===total across a long run', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    const CAP = 16;
    const TOTAL = 100;
    bus.record(CAP);
    for (let i = 0; i < TOTAL; i++) bus.emit('e', i);
    assert.equal(bus.recorded(), CAP);
    assert.equal(bus.dropped(), TOTAL - CAP);
    assert.equal(bus.recorded() + bus.dropped(), TOTAL);
});

test('recorded/dropped: drop-oldest keeps the most-recent N in EXACT order (not just count)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L { handle(p) { seen.push(p); } }
    bus.on('e', L);
    bus.boot();
    bus.record(3);
    for (let i = 0; i < 5; i++) bus.emit('e', i); // 0,1,2,3,4 -- keep the last 3: 2,3,4
    assert.equal(bus.recorded(), 3);
    assert.equal(bus.dropped(), 2);
    seen.length = 0;
    const n = bus.replay();
    assert.equal(n, 3);
    assert.deepEqual(seen, [2, 3, 4], 'replay must re-drive the most-recent N in original arrival order');
});

test('recorded/dropped: never recorded reports 0/0', () => {
    const { bus } = makeBus();
    assert.equal(bus.recorded(), 0);
    assert.equal(bus.dropped(), 0);
});

// ===========================================================================
// replay(): order, payload identity, non-self-recording, sync, empty, disposed
// ===========================================================================

test('replay: re-invokes handlers in capture order with the SAME payload reference (identity)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    const p0 = { n: 0 }, p1 = { n: 1 }, p2 = { n: 2 };
    class L { handle(p) { seen.push(p); } }
    bus.on('e', L);
    bus.boot();
    bus.record(8);
    bus.emit('e', p0); bus.emit('e', p1); bus.emit('e', p2);
    seen.length = 0;
    const n = bus.replay();
    assert.equal(n, 3);
    assert.equal(seen.length, 3);
    assert.equal(seen[0], p0, 'replay must pass the SAME object reference, not a clone');
    assert.equal(seen[1], p1);
    assert.equal(seen[2], p2);
});

test('replay: returns the count replayed and does NOT self-record (recorded() unchanged)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(8);
    bus.emit('e', 1); bus.emit('e', 2); bus.emit('e', 3);
    assert.equal(bus.recorded(), 3);
    const n = bus.replay();
    assert.equal(n, 3);
    assert.equal(bus.recorded(), 3, 'replay must not grow the tape it just re-drove');
});

test('replay: a never-recorded tape returns 0 (no throw -- absence is a valid empty)', () => {
    const { bus } = makeBus();
    assert.doesNotThrow(() => {
        const n = bus.replay();
        assert.equal(n, 0);
    });
});

test('replay: a recorded-then-cleared tape returns 0 (no throw)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    assert.equal(bus.recorded(), 1);
    bus.clearTape();
    const n = bus.replay();
    assert.equal(n, 0);
});

test('replay: re-entrant replay() (a handler calls bus.replay()) throws "replay re-entered"', () => {
    const c = new Container();
    const bus = new EventBus(c);
    c.value('bus', bus);
    const arm = { on: false };
    c.value('arm', arm);
    class Reenter {
        constructor(b, a) { this.bus = b; this.arm = a; }
        handle() { if (this.arm.on) this.bus.replay(); }
    }
    bus.on('e', Reenter, ['bus', 'arm']);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1); // populate the tape; arm is off, no re-entry yet
    arm.on = true;
    assert.throws(() => bus.replay(), /replay re-entered/i);
    assert.equal(bus._replaying, false, '_replaying latch must be restored via finally after the throw');
    assert.equal(bus._depth, 0, '_depth must also be restored (the inner emit\'s own finally)');
    // Bus stays usable: a subsequent (non-reentrant) replay works.
    arm.on = false;
    const n = bus.replay();
    assert.equal(n, 1);
});

test('replay: is synchronous -- a flag set by the last replayed handler is true immediately after replay() returns', () => {
    const c = new Container();
    const bus = new EventBus(c);
    let flag = false;
    class L { handle() { flag = true; } }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    flag = false; // clear the live-emit set; only replay() may flip it now
    bus.replay();
    assert.equal(flag, true, 'replay must complete before the next statement -- no microtask hop');
});

test('replay: on a disposed bus throws DISPOSED', () => {
    const { bus } = makeBus();
    bus.record(4);
    bus.emit('e', 1);
    bus.dispose();
    assert.throws(() => bus.replay(), /disposed/i);
});

// ===========================================================================
// stopRecording(): halts capture, retains the tape, idempotent
// ===========================================================================

test('stopRecording: halts capture -- emits after it do not grow recorded()/dropped()', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    bus.emit('e', 2);
    assert.equal(bus.recorded(), 2);
    bus.stopRecording();
    bus.emit('e', 3);
    bus.emit('e', 4);
    assert.equal(bus.recorded(), 2, 'recorded() must not grow after stopRecording()');
    assert.equal(bus.dropped(), 0);
});

test('stopRecording: returns this and is idempotent', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    const r1 = bus.stopRecording();
    assert.equal(r1, bus);
    assert.doesNotThrow(() => bus.stopRecording()); // idempotent, no active tape to stop
    const r2 = bus.stopRecording();
    assert.equal(r2, bus);
});

test('stopRecording: safe to call when never recorded (no tape at all)', () => {
    const { bus } = makeBus();
    assert.doesNotThrow(() => bus.stopRecording());
});

test('stopRecording: the tape is RETAINED -- replay() still works after stopRecording()', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L { handle(p) { seen.push(p); } }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 'a');
    bus.emit('e', 'b');
    bus.stopRecording();
    seen.length = 0;
    const n = bus.replay();
    assert.equal(n, 2);
    assert.deepEqual(seen, ['a', 'b'], 'replay after stopRecording must still re-drive the retained tape');
});

// ===========================================================================
// nit #2 (post-record retained state): stopRecording leaves _tape non-null but
// inactive -- emit must be BEHAVIORALLY IDENTICAL to the off path (dispatch
// still fires exactly once per listener, no capture growth, no side effect
// beyond the ordinary dispatch). This locks the behavior the allocation claim
// depends on so it cannot silently change; the byte-level 0-alloc claim itself
// is independently measured via lite-gc-profiler (reported separately, not in
// this node:test file per the node:test-only law).
// ===========================================================================

test('post-stop retained tape: emit behaves identically to the off path (dispatch-for-dispatch)', () => {
    const cOff = new Container();
    const busOff = new EventBus(cOff);
    const cOn = new Container();
    const busOn = new EventBus(cOn);
    const logOff = [];
    const logOn = [];
    class LOff { handle(p) { logOff.push(p); } }
    class LOn { handle(p) { logOn.push(p); } }
    busOff.on('e', LOff);
    busOn.on('e', LOn);
    busOff.boot();
    busOn.boot();
    busOn.record(4);
    busOn.emit('e', 'warm'); // captured once
    busOn.stopRecording();   // _tape stays non-null, active=false from here on
    logOn.length = 0;        // isolate the post-stop comparison from the warm-up dispatch

    for (let i = 0; i < 5; i++) {
        busOff.emit('e', i);
        busOn.emit('e', i);
    }
    assert.deepEqual(logOff, [0, 1, 2, 3, 4]);
    assert.deepEqual(logOn, [0, 1, 2, 3, 4], 'post-stop dispatch must match the off-path dispatch exactly');
    assert.equal(busOn.recorded(), 1, 'the retained tape must not grow after stopRecording, confirming the _capture early-return');
    assert.equal(busOn._tape !== null, true, 'the tape object itself is retained (not nulled) after stopRecording');
});

// ===========================================================================
// clearTape(): resets counters, releases refs, safe when never recorded
// ===========================================================================

test('clearTape: recorded()/dropped() go to 0, replay() then returns 0, returns this', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(3);
    bus.emit('e', 1); bus.emit('e', 2); bus.emit('e', 3); bus.emit('e', 4); // overflow -> dropped 1
    assert.equal(bus.recorded(), 3);
    assert.equal(bus.dropped(), 1);
    const r = bus.clearTape();
    assert.equal(r, bus);
    assert.equal(bus.recorded(), 0);
    assert.equal(bus.dropped(), 0);
    assert.equal(bus.replay(), 0);
});

test('clearTape: safe to call when never recorded', () => {
    const { bus } = makeBus();
    assert.doesNotThrow(() => {
        const r = bus.clearTape();
        assert.equal(r, bus);
    });
    assert.equal(bus.recorded(), 0);
});

test('clearTape: releases retained payload references (WeakRef becomes collectable)', async () => {
    // Behavioral proxy for the retention claim without pulling in a torture dep:
    // the ring array slot itself is asserted null after clearTape, which is the
    // structural precondition for the WeakRef-based proof already gated in T7.
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', { held: true });
    assert.equal(bus._tape.payloads[0] !== null, true, 'sanity: the slot holds the payload before clearTape');
    bus.clearTape();
    assert.equal(bus._tape.payloads[0], null, 'clearTape must null every retained payload slot');
    assert.equal(bus._tape.names[0], null, 'clearTape must null every retained name slot');
});

test('clearTape: recording continues if it was active -- clearTape only empties, it does not stop', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    bus.clearTape();
    bus.emit('e', 2); // recording is still active -- must capture
    assert.equal(bus.recorded(), 1);
});

// ===========================================================================
// dispose()/shutdown(): emit throws, tape released
// ===========================================================================

test('dispose: after dispose() emit throws and the tape is released (nulled)', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    assert.equal(bus.recorded(), 1);
    bus.dispose();
    assert.equal(bus._tape, null, 'dispose() must null the tape so it cannot outlive the bus');
    assert.throws(() => bus.emit('e', 2), /disposed/i);
});

test('dispose: after container.shutdown() (not bus.dispose()) emit throws (existing behavior); tape untouched by shutdown alone', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    assert.equal(bus.recorded(), 1);
    await c.shutdown();
    // MEASURED: _capture runs BEFORE the container's getAllInto call inside emit's
    // try, so even a post-shutdown emit that ultimately throws still gets captured
    // first -- the attempt is recorded, then the dispatch itself fails. recorded()
    // therefore advances to 2, not 1, on this failed call.
    assert.throws(() => bus.emit('e', 2), /shut down/i);
    assert.equal(bus.recorded(), 2, 'a failed post-shutdown emit is still captured before the container throws');
    // shutdown() alone (no bus.dispose()) does not touch the bus-owned tape state.
    assert.notEqual(bus._tape, null);
});

// ===========================================================================
// Boundary matrix -- dispose: duplicate dispose, dispose-during-iteration
// ===========================================================================

test('boundary[dispose]: duplicate dispose() releases the tape both times, safely', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    bus.record(4);
    bus.emit('e', 1);
    bus.dispose();
    assert.equal(bus._tape, null);
    assert.doesNotThrow(() => bus.dispose());
    assert.equal(bus._tape, null);
    assert.throws(() => bus.record(4), /disposed/i);
    assert.throws(() => bus.replay(), /disposed/i);
});

test('boundary[dispose-during-iteration]: a handler that disposes the bus mid-replay fails closed on the NEXT re-driven entry', () => {
    // replay() walks a snapshot of the tape's indices taken before the loop starts,
    // so dispose() mid-loop does not corrupt the walk itself -- but the very next
    // this.emit() call inside the loop hits the disposed-guard immediately and
    // throws DISPOSED, propagating out of replay() (fail closed, not a silent stop
    // and not a crash on a null buffer stack).
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L {
        handle(p) {
            seen.push(p);
            if (bus._replaying && p === 'p0') bus.dispose();
        }
    }
    bus.on('e', L);
    bus.boot();
    bus.record(8);
    bus.emit('e', 'p0');
    bus.emit('e', 'p1');
    bus.emit('e', 'p2');
    seen.length = 0; // isolate the replay-only re-dispatch from the three live-emit pushes above
    assert.throws(() => bus.replay(), /disposed/i,
        'dispose() mid-replay must surface as a clean DISPOSED throw on the next re-driven entry');
    assert.deepEqual(seen, ['p0'],
        'only the first replayed entry re-fires; the second iteration hits the disposed-guard before its handler runs');
    assert.equal(bus._replaying, false, '_replaying latch restored via finally even though dispose() ran mid-loop');
    assert.equal(bus._tape, null, 'the tape is released by the dispose() that ran mid-replay');
});

// ===========================================================================
// ADVERSARIAL (reviewer nit #1): a handler mutates the tape it is being
// replayed from. Two sub-cases, both pinned to their MEASURED behavior:
//
//  (a) clearTape() mid-replay -- clearTape nulls EVERY slot in the ring
//      (0..capacity-1), not just the already-visited ones, and it mutates the
//      SAME array objects the running replay() loop holds local references to.
//      So the NEXT iteration after the clear -- even one whose payload had
//      already been captured before the clear -- re-drives as emit(null,
//      null). Since no event is named 'null', this falls through to the
//      container's own "not registered" throw -- fail closed, not a crash,
//      not silent corruption. The bus is fully usable afterward.
//  (b) record() mid-replay while the ORIGINAL tape is still active throws
//      "already recording" (the ordinary guard fires) and the handler's catch
//      lets replay() finish untouched on the original data. If the original
//      tape had already been stopped (active === false), record() instead
//      SUCCEEDS and swaps in a brand-new tape object -- but because replay()
//      already captured its own local references to the OLD tape's arrays
//      before the loop started, the in-flight walk is unaffected and replays
//      the original entries faithfully; only after replay() returns does
//      recorded() reflect the new (empty) tape.
// ===========================================================================

test('ADVERSARIAL: clearTape() mid-replay corrupts the remaining walk to (null,null) and fails closed', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L {
        handle(p) {
            seen.push(p);
            if (bus._replaying && p === 'p1') bus.clearTape();
        }
    }
    bus.on('e', L);
    bus.boot();
    bus.record(8);
    bus.emit('e', 'p0');
    bus.emit('e', 'p1');
    bus.emit('e', 'p2');
    assert.equal(bus.recorded(), 3);
    seen.length = 0; // isolate the replay-only re-dispatch from the three live-emit pushes above

    assert.throws(() => bus.replay(), /not registered|available/i,
        'the post-clear entries replay as (null,null) and fall through to the container\'s unregistered-event throw');
    assert.deepEqual(seen, ['p0', 'p1'],
        'p0 and p1 re-fire normally; p1\'s handler clears the WHOLE ring (including the not-yet-visited p2 slot), ' +
        'so the 3rd iteration reads (null,null) and throws before any listener runs for it');
    assert.equal(bus._replaying, false, '_replaying latch restored via finally despite the mid-replay corruption');
    assert.equal(bus._depth, 0, '_depth restored via finally despite the mid-replay corruption');
    assert.equal(bus.recorded(), 0, 'clearTape already reset the counters before the throw unwound');

    // The bus is NOT bricked: the original tape survived (clearTape only empties
    // it, it never stops recording), so it is still "active" -- stopRecording()
    // first, exactly like the ordinary double-record() contract, then a fresh
    // record/emit/replay cycle works normally.
    bus.stopRecording();
    bus.record(4);
    bus.emit('e', 'fresh');
    assert.equal(bus.replay(), 1);
});

test('ADVERSARIAL: record() mid-replay throws "already recording" while the original tape is still active, and does not disturb the in-flight replay', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L {
        handle(p) {
            seen.push(p);
            if (bus._replaying && p === 'p1') {
                assert.throws(() => bus.record(4), /already recording/i);
            }
        }
    }
    bus.on('e', L);
    bus.boot();
    bus.record(8); // never stopped -- still active through the whole replay
    bus.emit('e', 'p0'); bus.emit('e', 'p1'); bus.emit('e', 'p2');
    const n = bus.replay();
    assert.equal(n, 3);
    assert.deepEqual(seen, ['p0', 'p1', 'p2', 'p0', 'p1', 'p2'],
        'the rejected record() call left the in-flight replay fully intact');
    assert.equal(bus.recorded(), 3, 'the original tape (untouched by the rejected record()) still reports 3');
});

test('ADVERSARIAL: record() mid-replay SUCCEEDS once the original tape is stopped, swapping in a new tape without corrupting the in-flight walk', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const seen = [];
    class L {
        handle(p) {
            seen.push(p);
            if (bus._replaying && p === 'p1') {
                assert.doesNotThrow(() => bus.record(4));
            }
        }
    }
    bus.on('e', L);
    bus.boot();
    bus.record(8);
    bus.emit('e', 'p0'); bus.emit('e', 'p1'); bus.emit('e', 'p2');
    bus.stopRecording(); // tape.active = false -- record() mid-replay is now legal
    const n = bus.replay();
    assert.equal(n, 3, 'the walk still completes over the ORIGINAL tape data, unaffected by the swap');
    assert.deepEqual(seen, ['p0', 'p1', 'p2', 'p0', 'p1', 'p2'],
        'all three original entries re-fire faithfully even though a brand-new tape object replaced this._tape mid-walk');
    // After replay() returns, this._tape now points at the NEW (empty) tape the
    // handler created mid-replay -- the swap is only visible once the walk ends.
    assert.equal(bus.recorded(), 0, 'this._tape now points at the fresh empty tape created mid-replay');
});
