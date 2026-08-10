/**
 * T7 -- soak and retention (A5). The AUTHORITY is FINALIZATION, not a counter trick.
 *
 * Three sub-phases exercise every retention path of an EventBus, and ALL of them track
 * the BUS with lite-leak WITHOUT untracking it (the cleanup NOOP + numeric/string tag
 * capture NOTHING, held-value contract), so each bus is held only WEAKLY. After the
 * last sub-phase we settle HARD (>= 10 gc()+tick passes) and assert the finalization
 * residual tracker.size() <= RES = max(16, TOTAL/1000): a bus that was really released
 * is collected (size--), one that leaked is not.
 *
 *   Sub-phase 1: CYCLES fresh-bus register/boot/emit/shutdown cycles (no dispose -- the
 *     bus falls out of scope on its own; proves an undisposed bus still finalizes).
 *   Sub-phase 2: ROUNDS long-lived buses driven then shutdown + dispose() -- dispose is
 *     the only path that nulls _container/_bufStack (buffers that can pin torn-down
 *     instances). Field-null release asserted per round.
 *   Sub-phase 3: NESTED_ROUNDS depth-4 nested-emit cascades so _bufStack[0..3] fill with
 *     live DI instances before shutdown + dispose. Field-null release asserted per round.
 *
 * (An earlier track+immediate-untrack asserted size()===0 -- a VACUOUS TAUTOLOGY the old
 * comments even called "decorative": unregister decrements the live counter
 * synchronously, netting to 0 every cycle even if every bus were retained forever.
 * Sub-phase 1 also tracked a throwaway {cycle} object, not the bus. Fixed here per the
 * promotion-ladder gate 2 -- a retention gate must FAIL on a retained object.)
 *
 * DI_TORTURE_BREAK=1 retains every tracked bus in a module sink -> size() stays ~TOTAL
 * and BLOWS RES, tripping the residual gate DIRECTLY. (Whole-suite control; in a full
 * run an earlier tier may trip first -- prove the soak in isolation:
 * DI_TORTURE_BREAK=1 node --expose-gc -e "import('./test/torture/t7-soak.mjs').then(m=>m.run())".)
 *
 * SECONDARY (NOT the authority): one coarse end-to-end heap-delta backstop bounding
 * one-time growth; deliberately loose, since the tracker holds ~TOTAL leakRecords live.
 * The load-bearing structural proof per round is the field-null release + fail-closed-
 * after-dispose assertions; the finalization residual is the retention authority.
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { EventBus } from '../../EventBus.js';
import { check, BREAK, STATS } from './harness.mjs';

const CYCLES = 2000;      // >= 1000 (A5)
const LISTENERS = 8;
const ROUNDS = 500;
const EMITS_PER_ROUND = 16;
const NESTED_ROUNDS = 500;
const NESTED_EMITS_PER_ROUND = 32;
const NESTED_DEPTH = 4;   // populates _bufStack[0..3], within MAX_DEPTH=8

const TOTAL = CYCLES + ROUNDS + NESTED_ROUNDS; // 3000 buses tracked
/** AUTHORITY residual ceiling. Clean leaves single digits; a real leak leaves ~TOTAL. */
const RES = Math.max(16, (TOTAL / 1000) | 0);  // 16

// SECONDARY loose catastrophe backstop (NOT the authority -- the finalization residual
// is). End-to-end one-time growth bound. Measured clean (node --expose-gc, 3 runs):
// 549.0 / 548.6 / 549.1 KB, residual size() <= 1 -- the delta is ~TOTAL live leakRecords
// plus heap-position noise, NOT a per-cycle signal. Anchored at 2 MB (~3.7x the plateau)
// to catch only runaway; the residual owns retention.
const HEAP_DELTA_LIMIT = 2 * 1024 * 1024;
const NOOP = function () {};

/** BREAK: retains every tracked bus so it can NEVER be finalized -> size() stays ~TOTAL. */
const sink = [];

/** Hard settle: run FinalizationRegistry callbacks to ground before reading size(). */
async function settleHard() {
    for (let i = 0; i < 10; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 15));
    }
}

export async function run() {
    const tracker = createLeakTracker({
        name: 'eb-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;

    // ---- Sub-phase 1: fresh bus per cycle, no dispose --------------------------
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

        await c.shutdown();

        // emit now fails closed -- the container is shut down.
        let threw = false;
        try { bus.emit('e', cyc); } catch (err) { threw = /shut down/i.test(err.message); }
        check(threw, () => `T7: cycle ${cyc} emit did not fail closed after shutdown`);

        // AUTHORITY: track the BUS without untracking; finalization decides its fate.
        // Neither NOOP nor the numeric tag closes over the bus (held-value contract).
        tracker.track(bus, NOOP, cyc);
        if (BREAK) sink.push(bus); // pin -> can NEVER be finalized -> size() stays high.
    }

    // ---- Sub-phase 2: long-lived bus + dispose() -------------------------------
    for (let r = 0; r < ROUNDS; r++) {
        const c = new Container();
        const bus = new EventBus(c);
        for (let i = 0; i < LISTENERS; i++) {
            class L { handle() {} }
            bus.on('e', L);
        }
        bus.boot();
        for (let e = 0; e < EMITS_PER_ROUND; e++) bus.emit('e', e);

        await c.shutdown();
        bus.dispose();

        // Field-null release: dispose() nulls every stack-holding field.
        check(bus._container === null && bus._bufStack === null && bus._counts === null,
            () => `T7.dispose: round ${r} did not release bus state`);
        let threw = false;
        try { bus.emit('e', 1); } catch { threw = true; }
        check(threw, () => `T7.dispose: round ${r} emit did not fail closed after dispose`);

        tracker.track(bus, NOOP, 'bus' + r);
        if (BREAK) sink.push(bus);
    }

    // ---- Sub-phase 3: nested-emit cascade, depth 4 -----------------------------
    // Each round runs a DEPTH-4 nested cascade (lvl0 -> lvl1 -> lvl2 -> lvl3, two
    // listeners each) repeatedly, so _bufStack[0..3] all fill with live DI instances
    // before shutdown + dispose -- exercising the depth>1 tail-retention path.
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

        await c.shutdown();
        bus.dispose();

        // Field-null release: every stack-holding field is gone, so nothing the depth>1
        // dispatch built (the Cascade/Sibling/Leaf instances filling _bufStack[0..3]) can
        // still be reached through the bus.
        check(bus._bufStack === null && bus._container === null && bus._counts === null && bus._depth === 0,
            () => `T7.nested: round ${r} did not release bus state (bufStack/container/counts/depth)`);
        let threw = false;
        try { bus.emit('n0', 1); } catch { threw = true; }
        check(threw, () => `T7.nested: round ${r} emit did not fail closed after dispose`);

        tracker.track(bus, NOOP, 'nested-bus' + r);
        if (BREAK) sink.push(bus);
    }

    // ---- AUTHORITY: finalization residual across ALL tracked buses -------------
    await settleHard();
    const residual = tracker.size();
    const findings = tracker.audit();
    STATS.leakSize = residual;
    STATS.leakTarget = RES;
    STATS.findings = findings.length;

    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);
    // AUTHORITY: finalization residual. A real leak would leave ~TOTAL.
    check(residual <= RES,
        () => `T7: AUTHORITY finalization residual size()=${residual} > ${RES} -- a bus outlived its shutdown/dispose`);

    // SECONDARY (NOT the authority): coarse end-to-end one-time-growth backstop.
    globalThis.gc();
    const delta = process.memoryUsage().heapUsed - heapBaseline;
    check(delta < HEAP_DELTA_LIMIT,
        () => `T7.heap: (secondary) soak heap delta ${(delta / 1024).toFixed(1)} KB >= ${(HEAP_DELTA_LIMIT / 1024)} KB`);

    process.stderr.write('T7 soak: ' + CYCLES + ' fresh + ' + ROUNDS + ' dispose + ' + NESTED_ROUNDS +
        ' nested rounds clean | AUTHORITY residual size()=' + residual + '/' + RES +
        ' findings=' + findings.length + ' | (secondary) heap delta=' + (delta / 1024).toFixed(1) + ' KB\n');
}
