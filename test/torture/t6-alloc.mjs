/**
 * T6 -- the zero-alloc gate (A1), plus the honest async lane.
 *
 * The sync emit path is the whole point of this package: one
 * container.getAllInto fill into a depth-indexed stack buffer + an index loop,
 * dispatching to DI-constructed singletons. The measured body drives a 4-DEEP
 * NESTED CASCADE (a listener emitting the next event, x4) so the depth push/pop
 * and the try/finally are inside the hot path (A8). On a booted, fully-cached
 * topology that is ZERO retained bytes per emit -- hard-gated here two ways:
 *
 *   Lane A  measureAllocs at maxBytesPerCall:0 -- RETAINED bytes, forced-collect.
 *   Lane B  measureOps(stabilize:'deep') over 1e6 emits -- major/pause/arrayBuffers
 *           budget via checkNoGc(maxMajor:0). PASS iff bytes/op === 0. The
 *           try/finally must add no allocation -- this is the load-bearing gate.
 *
 * emitAsync is the honest boundary: awaiting a handler allocates promise
 * machinery BY CONSTRUCTION, so it is RECORDED and loosely PINNED, never gated at
 * zero. Claiming zero there would be a lie.
 *
 * DI_ALLOC_BREAK=1 injects one retained allocation PER EMIT into the measured
 * body; the gate must then reject both lanes. That is the per-emit control.
 */

import { measureAllocs, checkAllocs, measureOpsAsync, checkOpsAsync }
    from '@zakkster/lite-gc-profiler';
import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '../../EventBus.js';
import { runOpsGate, ALLOC_BREAK, BREAK, check, die, STATS } from './harness.mjs';

const HOT = 1000000;      // 1e6 emits (A1)
const PIN_ASYNC = 512;    // B/op ceiling for emitAsync -- recorded, loosely pinned
const REC_CAP = 1024;     // recorder-ON ring capacity (A2)

/** One payload reference reused across every recorded emit -- a ref store is 0 B. */
const REC_PAYLOAD = { tag: 'rec' };

// Either break flag injects a retained per-emit allocation so the gate rejects:
// DI_ALLOC_BREAK is the per-emit control; DI_TORTURE_BREAK is the whole-suite one.
const INJECT = ALLOC_BREAK || BREAK;

/** Retained sink for the break control -- survives GC so the gate must reject. */
const sink = [];

export async function run() {
    // Everything the hot body touches is built ONCE here, outside every window.
    // A 4-deep cascade: emit('e0') -> listener emits 'e1' -> 'e2' -> 'e3' (leaf).
    // Each level takes the NEXT stack buffer, so the measured emit exercises the
    // depth push/pop and the try/finally at every level (A8). Listeners get the
    // bus injected as a container value, so the cascade is pure DI dispatch.
    const c = new Container();
    let hits = 0;
    const bus = new EventBus(c);
    c.value('bus', bus);
    class L0 { constructor(b) { this.bus = b; } handle(p) { this.bus.emit('e1', p); } }
    class L1 { constructor(b) { this.bus = b; } handle(p) { this.bus.emit('e2', p); } }
    class L2 { constructor(b) { this.bus = b; } handle(p) { this.bus.emit('e3', p); } }
    class L3 { handle(p) { hits += p; } } // leaf -- no further emit
    bus.on('e0', L0, ['bus']);
    bus.on('e1', L1, ['bus']);
    bus.on('e2', L2, ['bus']);
    bus.on('e3', L3);
    bus.boot();

    // Warm every cache so the measured windows see the steady state.
    const payload = 7;
    for (let i = 0; i < 5000; i++) bus.emit('e0', payload);

    const stackBefore = bus._bufStack;
    const flagBytesBefore = c._resolvedFlags.get('e3').buffer.byteLength;

    // ---- Lane A: retained bytes per emit -- HARD-gated at 0 -----------------
    const la = measureAllocs(
        () => { bus.emit('e0', payload); if (INJECT) sink.push(new Float64Array(8)); },
        { iterations: 5000, batches: 12, warmup: 5000 });
    const ca = checkAllocs(la, { maxBytesPerCall: 0 });
    check(ca.verdict === 'pass' && la.bytesPerCall === 0,
        () => `T6.A1 laneA: emit (4-deep cascade) must be 0 B/emit, measured ${la.bytesPerCall} (verdict=${ca.verdict})` +
            (INJECT ? ' (break control -- expected)' : ''));
    if (INJECT) die('T6.A1: DI_ALLOC_BREAK injected allocations but laneA gate passed');
    sink.length = 0;

    // ---- Lane B: 1e6 emits (4-deep cascade) -- major/pause/arrayBuffers budget
    const hot = () => { bus.emit('e0', payload); if (INJECT) sink.push(new Float64Array(8)); };
    const { report, summary } = runOpsGate(hot, { ops: HOT, warmup: 5000 });

    // Structural assertions no heap gate can make.
    check(bus._bufStack === stackBefore, () => 'T6.struct: the buffer stack was reallocated during emit');
    check(bus._depth === 0, () => `T6.struct: _depth not restored to 0 after the cascade (=${bus._depth})`);
    check(c._path.length === 0, () => `T6.struct: container _path leaked (len=${c._path.length})`);
    check(c._resolvedFlags.get('e3').buffer.byteLength === flagBytesBefore,
        () => 'T6.struct: multi flags array regrew during the emit soak');

    STATS.gcMajor = summary.gc.major;
    STATS.gcMinor = summary.gc.minor;
    STATS.gcMaxMs = summary.gc.maxMs;
    // Report the HARD-gated retained figure (laneA measureAllocs, forced-collect),
    // not laneB's heap-slope estimate, which carries sub-byte sampling noise. The
    // laneB budget is still enforced below via checkNoGc(report.ok).
    STATS.allocBytesPerOp = la.bytesPerCall;

    if (!report.ok) {
        const g = summary.gc;
        die('T6.A1 laneB rejected -- verdict=' + report.verdict +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' abGrowth=' + summary.arrayBuffers.growthBytes +
            (INJECT ? ' (break control -- expected)' : ''));
    }
    if (INJECT) die('T6.A1: DI_ALLOC_BREAK injected allocations but laneB gate passed');

    // ---- A2: recorder-ON lane -- fixed ring, 0 B/emit steady-state ----------
    // A SEPARATE gate from A1: recording deliberately RETAINS payload refs, but the
    // steady-state capture is reference stores into a PRE-SIZED ring at a rolling
    // head -- no growth, no per-emit allocation. Warmed past capacity so every
    // measured emit is a drop-oldest OVERWRITE (the fullest-work path).
    const rc = new Container();
    let rhits = 0;
    const rbus = new EventBus(rc);
    class RL { handle(p) { rhits += (p === REC_PAYLOAD ? 1 : 0); } }
    rbus.on('rec', RL);
    rbus.boot();
    rbus.record(REC_CAP);
    for (let i = 0; i < REC_CAP * 4; i++) rbus.emit('rec', REC_PAYLOAD);

    const lr = measureAllocs(
        () => { rbus.emit('rec', REC_PAYLOAD); if (INJECT) sink.push(new Float64Array(8)); },
        { iterations: 5000, batches: 12, warmup: 5000 });
    const cr = checkAllocs(lr, { maxBytesPerCall: 0 });
    check(cr.verdict === 'pass' && lr.bytesPerCall === 0,
        () => `T6.A2: recorder-ON emit must be 0 B/emit, measured ${lr.bytesPerCall} (verdict=${cr.verdict})` +
            (INJECT ? ' (break control -- expected)' : ''));
    if (INJECT) die('T6.A2: DI_ALLOC_BREAK injected allocations but the recorder-ON lane passed');
    sink.length = 0;
    check(rbus.recorded() <= REC_CAP,
        () => `T6.A2: recorded() ${rbus.recorded()} exceeded capacity ${REC_CAP}`);

    // Accounting: a fresh 1e6-emit run. drop-oldest must account for every overwrite,
    // so recorded()+dropped() === total emitted and recorded() pins at capacity.
    const ac = new Container();
    const abus = new EventBus(ac);
    class AL { handle() {} }
    abus.on('rec', AL);
    abus.boot();
    abus.record(REC_CAP);
    for (let i = 0; i < HOT; i++) abus.emit('rec', REC_PAYLOAD);
    check(abus.recorded() === REC_CAP,
        () => `T6.A2: recorded() ${abus.recorded()} != ${REC_CAP} after ${HOT} emits`);
    check(abus.recorded() + abus.dropped() === HOT,
        () => `T6.A2: recorded()+dropped() = ${abus.recorded() + abus.dropped()} != ${HOT} (drop-oldest lost accounting)`);

    // ---- Async lane: emitAsync (leaf event) -- RECORDED, loosely PINNED ------
    const as = await measureOpsAsync(async () => { await bus.emitAsync('e3', payload); },
        { ops: 50000, warmup: 5000 });
    const cas = checkOpsAsync(as, { maxBytesPerOp: PIN_ASYNC });
    check(cas.verdict === 'pass',
        () => `T6.async: emitAsync rate ${as.bytesPerOp.toFixed(3)} B/op > pin ${PIN_ASYNC}`);

    // Diagnostic line (stderr): the honest per-lane baseline this run measured.
    process.stderr.write(
        'T6 lanes: emit=' + la.bytesPerCall.toFixed(3) + ' B/emit (' + HOT + ' ops)' +
        ' recorderOn=' + lr.bytesPerCall.toFixed(3) + ' B/emit' +
        ' emitAsync=' + as.bytesPerOp.toFixed(3) + ' B/op' +
        ' | laneB major=' + summary.gc.major + ' minor=' + summary.gc.minor +
        ' maxMs=' + summary.gc.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes +
        ' | hits=' + hits + ' rhits=' + rhits + '\n');
}
