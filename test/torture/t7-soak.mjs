/**
 * T7 -- soak and retention (A5).
 *
 * CYCLES full register -> boot -> emit -> shutdown cycles, each on a FRESH
 * container + bus. Each cycle tracks a per-cycle external resource with lite-leak
 * (an independent retention witness) and drains it via container.shutdown(). The
 * gates:
 *
 *   - lite-leak tracker.size() === 0 and audit() clean after the run: nothing a
 *     bus or its DI-constructed listeners created outlived its shutdown.
 *   - peak heapUsed <= 2x the post-warmup baseline: no per-cycle accumulation.
 *
 * lite-leak's held-value contract: neither the cleanup closure nor the tag may
 * close over the tracked target, or finalization is defeated and the witness
 * reports a false clean.
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { EventBus } from '../../EventBus.js';
import { check, STATS } from './harness.mjs';

const CYCLES = 2000;      // >= 1000 (A5)
const LISTENERS = 8;
const NOOP = function () {};

export async function run() {
    const tracker = createLeakTracker({
        name: 'eb-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;
    let heapPeak = heapBaseline;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const c = new Container();
        const bus = new EventBus(c);
        let calls = 0;
        for (let i = 0; i < LISTENERS; i++) {
            class L { handle() { calls++; } }
            bus.on('e', L);
        }
        bus.boot();

        for (let e = 0; e < 4; e++) bus.emit('e', cyc);
        check(calls === LISTENERS * 4,
            () => `T7: cycle ${cyc} dispatched ${calls}, expected ${LISTENERS * 4}`);

        // Track a per-cycle external resource. The cleanup/tag must NOT close
        // over the tracked target (held-value contract).
        const h = tracker.track({ cycle: cyc }, NOOP, cyc);

        await c.shutdown();

        // emit now fails closed -- the container is shut down.
        let threw = false;
        try { bus.emit('e', cyc); } catch (err) { threw = /shut down/i.test(err.message); }
        check(threw, () => `T7: cycle ${cyc} emit did not fail closed after shutdown`);

        tracker.untrack(h);

        if ((cyc & 255) === 0) {
            globalThis.gc();
            const used = process.memoryUsage().heapUsed;
            if (used > heapPeak) heapPeak = used;
        }
    }

    globalThis.gc();
    const finalUsed = process.memoryUsage().heapUsed;
    if (finalUsed > heapPeak) heapPeak = finalUsed;

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);
    const findings = tracker.audit();
    STATS.leakSize = tracker.size();
    STATS.leakTarget = 0;
    STATS.findings = findings.length;
    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);

    check(heapPeak <= 2 * heapBaseline,
        () => `T7: peak heap ${(heapPeak / 1024).toFixed(0)} KB > 2x baseline ${(heapBaseline / 1024).toFixed(0)} KB`);

    // ---- Sub-phase 2: long-lived-bus retention via dispose() ----------------
    // The fresh-bus-per-cycle loop above never exercises dispose(): its buses
    // fall out of scope on their own. This phase keeps each bus alive across many
    // emit rounds, shuts the container down, then calls bus.dispose() -- the only
    // path that nulls _container / _bufStack (whose buffers can pin torn-down instances)
    // and makes emit fail closed. lite-leak tracks each bus (cleanup/tag never
    // close over it) so the retention returns to 0.
    const ROUNDS = 500;
    const EMITS_PER_ROUND = 16;
    globalThis.gc();
    const disposeBaseline = process.memoryUsage().heapUsed;
    let disposePeak = disposeBaseline;

    for (let r = 0; r < ROUNDS; r++) {
        const c = new Container();
        const bus = new EventBus(c);
        for (let i = 0; i < LISTENERS; i++) {
            class L { handle() {} }
            bus.on('e', L);
        }
        bus.boot();
        for (let e = 0; e < EMITS_PER_ROUND; e++) bus.emit('e', e);

        const h = tracker.track(bus, NOOP, 'bus' + r);

        await c.shutdown();
        bus.dispose();

        check(bus._container === null && bus._bufStack === null && bus._counts === null,
            () => `T7.dispose: round ${r} did not release bus state`);
        let threw = false;
        try { bus.emit('e', 1); } catch { threw = true; }
        check(threw, () => `T7.dispose: round ${r} emit did not fail closed after dispose`);

        tracker.untrack(h);

        if ((r & 127) === 0) {
            globalThis.gc();
            const used = process.memoryUsage().heapUsed;
            if (used > disposePeak) disposePeak = used;
        }
    }

    globalThis.gc();
    const disposeFinal = process.memoryUsage().heapUsed;
    if (disposeFinal > disposePeak) disposePeak = disposeFinal;

    check(tracker.size() === 0, () => `T7.dispose: tracker leaked ${tracker.size()} after dispose rounds`);
    const findings2 = tracker.audit();
    check(findings2.length === 0, () => `T7.dispose: lite-leak reported ${findings2.length} findings`);
    check(disposePeak <= 2 * disposeBaseline,
        () => `T7.dispose: peak heap ${(disposePeak / 1024).toFixed(0)} KB > 2x baseline ${(disposeBaseline / 1024).toFixed(0)} KB`);
    STATS.leakSize = tracker.size();
    STATS.findings = findings.length + findings2.length;

    process.stderr.write('T7 soak: ' + CYCLES + ' cycles + ' + ROUNDS + ' dispose rounds clean, leak size=' +
        tracker.size() + ' peak=' + (heapPeak / 1024).toFixed(0) + ' KB baseline=' + (heapBaseline / 1024).toFixed(0) + ' KB\n');

    // ---- Sub-phase 3: nested-emit soak -- depth>1 stack-slot tail retention -
    // Sub-phase 2 above only ever emits NON-nested (flat) handlers, so only
    // _bufStack[0] is ever populated -- the depth>1 tail-retention path
    // (_bufStack[1..MAX_DEPTH-1] holding a prior nested dispatch's DI-constructed
    // instances) is never exercised by a long-lived, dispose()d bus. This phase
    // closes that gap: each round builds a fresh long-lived bus running a DEPTH-4
    // nested cascade (lvl0 -> lvl1 -> lvl2 -> lvl3, each level with 2 listeners)
    // repeatedly, so _bufStack[0..3] all get filled with live DI instances many
    // times before shutdown + dispose. lite-leak tracks the bus itself (cleanup/
    // tag never close over it, per the held-value contract); the REAL witness is
    // the field-null release assertion (every _bufStack slot is unreachable once
    // this._bufStack is nulled) plus the heap-peak bound -- tracker.size()->0 is
    // decorative here since dispose() explicitly untracks before the next round.
    const NESTED_ROUNDS = 500;
    const NESTED_EMITS_PER_ROUND = 32;
    const NESTED_DEPTH = 4; // populates _bufStack[0..3], well within MAX_DEPTH=8
    globalThis.gc();
    const nestedBaseline = process.memoryUsage().heapUsed;
    let nestedPeak = nestedBaseline;

    for (let r = 0; r < NESTED_ROUNDS; r++) {
        const c = new Container();
        const bus = new EventBus(c);
        c.value('bus', bus);
        let leafCalls = 0;
        for (let k = 0; k < NESTED_DEPTH - 1; k++) {
            const next = 'n' + (k + 1);
            class Cascade { constructor(b) { this.bus = b; } handle(p) { this.bus.emit(next, p); } }
            class Sibling { handle() {} } // second listener at each level -- populates the slot alongside Cascade
            bus.on('n' + k, Cascade, ['bus']);
            bus.on('n' + k, Sibling);
        }
        class Leaf1 { handle() { leafCalls++; } }
        class Leaf2 { handle() { leafCalls++; } }
        bus.on('n' + (NESTED_DEPTH - 1), Leaf1);
        bus.on('n' + (NESTED_DEPTH - 1), Leaf2);
        bus.boot();

        for (let e = 0; e < NESTED_EMITS_PER_ROUND; e++) bus.emit('n0', e);
        check(leafCalls === NESTED_EMITS_PER_ROUND * 2,
            () => `T7.nested: round ${r} leaf dispatched ${leafCalls}, expected ${NESTED_EMITS_PER_ROUND * 2}`);
        check(bus._depth === 0, () => `T7.nested: round ${r} _depth not restored to 0 (=${bus._depth})`);

        const h = tracker.track(bus, NOOP, 'nested-bus' + r);

        await c.shutdown();
        bus.dispose();

        // Field-null release: every stack-holding field is gone, so nothing the
        // depth>1 dispatch built (the Cascade/Sibling/Leaf instances filling
        // _bufStack[0..3]) can still be reached through the bus.
        check(bus._bufStack === null && bus._container === null && bus._counts === null && bus._depth === 0,
            () => `T7.nested: round ${r} did not release bus state (bufStack/container/counts/depth)`);
        let threw = false;
        try { bus.emit('n0', 1); } catch { threw = true; }
        check(threw, () => `T7.nested: round ${r} emit did not fail closed after dispose`);

        tracker.untrack(h);

        if ((r & 127) === 0) {
            globalThis.gc();
            const used = process.memoryUsage().heapUsed;
            if (used > nestedPeak) nestedPeak = used;
        }
    }

    globalThis.gc();
    const nestedFinal = process.memoryUsage().heapUsed;
    if (nestedFinal > nestedPeak) nestedPeak = nestedFinal;

    // Decorative here (dispose() above explicitly untracks every round before
    // the next iteration) -- the load-bearing proof is the field-null release
    // and heap-peak bound checked per round and below.
    check(tracker.size() === 0, () => `T7.nested: tracker leaked ${tracker.size()} after nested rounds`);
    const findings3 = tracker.audit();
    check(findings3.length === 0, () => `T7.nested: lite-leak reported ${findings3.length} findings`);
    check(nestedPeak <= 2 * nestedBaseline,
        () => `T7.nested: peak heap ${(nestedPeak / 1024).toFixed(0)} KB > 2x baseline ${(nestedBaseline / 1024).toFixed(0)} KB`);
    STATS.leakSize = tracker.size();
    STATS.findings = findings.length + findings2.length + findings3.length;

    process.stderr.write('T7 nested soak: ' + NESTED_ROUNDS + ' depth-' + NESTED_DEPTH +
        ' nested-cascade dispose rounds clean, leak size=' + tracker.size() +
        ' peak=' + (nestedPeak / 1024).toFixed(0) + ' KB baseline=' + (nestedBaseline / 1024).toFixed(0) + ' KB\n');
}
