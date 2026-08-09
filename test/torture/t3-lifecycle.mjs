/**
 * T3 -- lifecycle and fail-closed sequencing (A2).
 *
 * The register -> boot -> emit -> shutdown -> emit-throws contract, plus the
 * boot lock on registration and the double-shutdown no-op. The load-bearing
 * property is that emit routes through the container with NO has() pre-gate, so
 * a post-shutdown emit THROWS instead of silently dispatching to torn-down
 * instances (the D-EB1 fail-closed guarantee).
 */

import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '../../EventBus.js';
import { check } from './harness.mjs';

export async function run() {
    // -- A2: register -> boot -> emit -> shutdown -> emit throws --------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        let calls = 0;
        class L { handle() { calls++; } }
        bus.on('e', L);
        bus.boot();

        bus.emit('e', 1);
        check(calls === 1, () => `T3.A2: pre-shutdown emit fired ${calls}, expected 1`);

        await c.shutdown();

        let threw = false;
        try { bus.emit('e', 2); } catch (e) { threw = /shut down/i.test(e.message); }
        check(threw, () => 'T3.A2: emit after shutdown did not throw a shut-down error (fail-open!)');
        check(calls === 1, () => `T3.A2: a listener fired after shutdown (calls=${calls})`);

        // Second shutdown resolves (no-op), does not reject.
        let ok = true;
        try { await c.shutdown(); } catch { ok = false; }
        check(ok, () => 'T3.A2: second shutdown rejected instead of resolving as a no-op');
    }

    // -- emitSafe and emitAsync also fail closed after shutdown --------------
    {
        const c = new Container();
        const bus = new EventBus(c, { onError() {} });
        let calls = 0;
        class L { handle() { calls++; } }
        bus.on('e', L);
        bus.boot();
        await c.shutdown();

        let safeThrew = false;
        try { bus.emitSafe('e', 1); } catch (e) { safeThrew = /shut down/i.test(e.message); }
        check(safeThrew, () => 'T3: emitSafe after shutdown did not fail closed');

        let asyncThrew = false;
        try { await bus.emitAsync('e', 1); } catch (e) { asyncThrew = /shut down/i.test(e.message); }
        check(asyncThrew, () => 'T3: emitAsync after shutdown did not fail closed');
        check(calls === 0, () => `T3: a listener fired after shutdown (calls=${calls})`);
    }

    // -- Boot lock: on() after the container is booted throws ----------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('e', L);
        bus.boot(); // boots the container
        let threw = false;
        try { bus.on('e', L); } catch (e) { threw = /after boot|topology/i.test(e.message); }
        check(threw, () => 'T3.lock: on() after boot did not throw a topology violation');
    }

    // -- Boot lock also trips when the container was booted externally --------
    {
        const c = new Container();
        c.value('x', 1);
        c.boot(); // external boot before any registration
        const bus = new EventBus(c);
        class L { handle() {} }
        let threw = false;
        try { bus.on('e', L); } catch (e) { threw = /after boot|topology/i.test(e.message); }
        check(threw, () => 'T3.lock: on() on an externally-booted container did not throw');
    }

    // -- emit before boot fails closed (no buffer allocated yet) -------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('e', L);
        let threw = false;
        try { bus.emit('e', 1); } catch { threw = true; }
        check(threw, () => 'T3.preboot: emit before boot did not fail closed');
    }

    // -- bus.boot() is idempotent --------------------------------------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('e', L);
        bus.boot();
        const stack = bus._bufStack;
        bus.boot();
        check(bus._bufStack === stack, () => 'T3.idempotent: second boot() rebuilt the buffer stack');
    }

    // -- S1: overlapping emitAsync must not cross the stack buffer ------------
    // Two overlapping (not nested) emitAsync calls on different events. Each
    // takes a stack slot only for its synchronous getAllInto fill, snapshots
    // into a fresh local, and releases the slot before its first await -- so
    // reading a stale buffer across the await cannot dispatch the wrong event's
    // listeners. Each listener must fire exactly once with ITS payload.
    {
        const c = new Container();
        const bus = new EventBus(c);
        const log = [];
        const rec = (tag) => class { async handle(p) { await Promise.resolve(); log.push(tag + '/' + p); } };
        bus.on('a', rec('A1')).on('a', rec('A2'));
        bus.on('b', rec('B1')).on('b', rec('B2'));
        bus.boot();

        const pa = bus.emitAsync('a', 'PA');
        const pb = bus.emitAsync('b', 'PB');
        await Promise.all([pa, pb]);

        const count = (v) => log.filter((x) => x === v).length;
        check(count('A1/PA') === 1, () => `T3.S1: A1/PA fired ${count('A1/PA')} times: ${log.join(',')}`);
        check(count('A2/PA') === 1, () => `T3.S1: A2/PA fired ${count('A2/PA')} times: ${log.join(',')}`);
        check(count('B1/PB') === 1, () => `T3.S1: B1/PB fired ${count('B1/PB')} times: ${log.join(',')}`);
        check(count('B2/PB') === 1, () => `T3.S1: B2/PB fired ${count('B2/PB')} times: ${log.join(',')}`);
        check(log.length === 4, () => `T3.S1: expected 4 dispatches, got ${log.length}: ${log.join(',')}`);
    }

    // -- A7: the qa reentrancy repro -- nested sync emit dispatches correctly -
    // outer=[Outer1,Outer2], inner=[Inner1,Inner2]; Outer1 synchronously emits
    // inner. With the buffer stack the exact order is [outer1, inner1, inner2,
    // outer2]: Outer2 fires once (its slot is NOT overwritten by inner's fill),
    // Inner2 fires once. The pre-fix single-shared-buffer bug produced
    // [outer1, inner1, inner2, inner2] (Outer2 dropped, Inner2 doubled).
    {
        const c = new Container();
        const bus = new EventBus(c);
        c.value('bus', bus);
        const log = [];
        class Outer1 { constructor(b) { this.bus = b; } handle(p) { log.push('outer1/' + p); this.bus.emit('inner', 'IN'); } }
        class Outer2 { handle(p) { log.push('outer2/' + p); } }
        class Inner1 { handle(p) { log.push('inner1/' + p); } }
        class Inner2 { handle(p) { log.push('inner2/' + p); } }
        bus.on('outer', Outer1, ['bus']).on('outer', Outer2);
        bus.on('inner', Inner1).on('inner', Inner2);
        bus.boot();

        bus.emit('outer', 'OUT');

        check(log.length === 4, () => `T3.A7: expected 4 dispatches, got ${log.length}: ${log.join(',')}`);
        check(log[0] === 'outer1/OUT', () => `T3.A7: log[0]=${log[0]} expected outer1/OUT (${log.join(',')})`);
        check(log[1] === 'inner1/IN', () => `T3.A7: log[1]=${log[1]} expected inner1/IN (${log.join(',')})`);
        check(log[2] === 'inner2/IN', () => `T3.A7: log[2]=${log[2]} expected inner2/IN (${log.join(',')})`);
        check(log[3] === 'outer2/OUT', () => `T3.A7: log[3]=${log[3]} expected outer2/OUT (${log.join(',')})`);
        check(bus._depth === 0, () => `T3.A7: _depth not restored to 0 (=${bus._depth})`);
    }

    // -- A9: a 9-deep cascade throws /nesting too deep/, then recovers ---------
    // lvl0..lvl7 each emit the next; emitting lvl8 happens at depth 8 (>= cap) and
    // throws. After the throw the try/finally chain has restored _depth to 0, and
    // the NEXT top-level emit on a separate event dispatches correctly.
    {
        const c = new Container();
        const bus = new EventBus(c);
        c.value('bus', bus);
        for (let k = 0; k < 8; k++) {
            const next = 'lvl' + (k + 1);
            class L { constructor(b) { this.bus = b; } handle(p) { this.bus.emit(next, p); } }
            bus.on('lvl' + k, L, ['bus']);
        }
        class Leaf { handle() {} }
        bus.on('lvl8', Leaf); // registered but reached only at depth 8 -> throws
        let safeCalls = 0;
        class Safe { handle() { safeCalls++; } }
        bus.on('safe', Safe);
        bus.boot();

        let threw = false;
        try { bus.emit('lvl0', 1); } catch (e) { threw = /nesting too deep/i.test(e.message); }
        check(threw, () => 'T3.A9: a 9-deep cascade did not throw /nesting too deep/');
        check(bus._depth === 0, () => `T3.A9: _depth not restored to 0 after the deep throw (=${bus._depth})`);

        bus.emit('safe', 1);
        check(safeCalls === 1, () => `T3.A9: recovery emit fired ${safeCalls}, expected 1`);
        check(bus._depth === 0, () => `T3.A9: _depth not 0 after recovery emit (=${bus._depth})`);
    }

    // -- A10: a handler that throws inside emit leaves _depth === 0 -----------
    // The finally restores depth even when a listener throws out of the loop.
    {
        const c = new Container();
        const bus = new EventBus(c);
        class Boom { handle() { throw new Error('listener boom'); } }
        bus.on('e', Boom);
        bus.boot();
        let threw = false;
        try { bus.emit('e', 1); } catch (e) { threw = /listener boom/.test(e.message); }
        check(threw, () => 'T3.A10: a throwing listener did not propagate out of emit');
        check(bus._depth === 0, () => `T3.A10: _depth not restored to 0 after a handler throw (=${bus._depth})`);
        // Still usable afterwards.
        let ok = false;
        try { bus.emit('e', 1); } catch { ok = true; }
        check(ok, () => 'T3.A10: bus unusable after a caught handler throw');
        check(bus._depth === 0, () => `T3.A10: _depth leaked after the second throw (=${bus._depth})`);
    }

    // -- S1 depth invariant: getAllInto-throw paths must NOT leak _depth ------
    // The fail-closed throws (unknown event, post-shutdown container) originate
    // INSIDE getAllInto. If the depth increment or the fill sat outside the try,
    // _depth would leak +1 per throw and brick the bus at 8. Both sync lanes must
    // restore _depth to 0 on every such throw.
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('e', L);
        bus.boot();

        // Unknown event: getAllInto throws unregistered. 8+ throws must not brick.
        for (let i = 0; i < 8; i++) {
            let threw = false;
            try { bus.emit('unknown', 1); } catch { threw = true; }
            check(threw, () => `T3.S1depth: emit('unknown') did not throw at i=${i}`);
            check(bus._depth === 0, () => `T3.S1depth: emit _depth leaked to ${bus._depth} after unknown-event throw #${i}`);
        }
        for (let i = 0; i < 8; i++) {
            let threw = false;
            try { bus.emitSafe('unknown', 1); } catch { threw = true; }
            check(threw, () => `T3.S1depth: emitSafe('unknown') did not throw at i=${i}`);
            check(bus._depth === 0, () => `T3.S1depth: emitSafe _depth leaked to ${bus._depth} after unknown-event throw #${i}`);
        }
        // After 16 fail-closed throws a VALID emit must still dispatch (not bricked).
        let calls = 0;
        class Counter { handle() { calls++; } }
        // fresh bus proves the "8 unknown then valid" recovery end-to-end
        const c2 = new Container();
        const bus2 = new EventBus(c2);
        bus2.on('e', Counter);
        bus2.boot();
        for (let i = 0; i < 8; i++) { try { bus2.emit('unknown', 1); } catch { /* expected */ } }
        check(bus2._depth === 0, () => `T3.S1depth: bus2 _depth leaked to ${bus2._depth} after 8 unknown-event throws`);
        bus2.emit('e', 1);
        check(calls === 1, () => `T3.S1depth: valid emit after 8 unknown throws fired ${calls}, expected 1 (bricked?)`);

        // Post-shutdown: getAllInto throws /shut down/. _depth must stay 0.
        await c.shutdown();
        let sThrew = false;
        try { bus.emit('e', 1); } catch (e) { sThrew = /shut down/i.test(e.message); }
        check(sThrew, () => 'T3.S1depth: post-shutdown emit did not fail closed');
        check(bus._depth === 0, () => `T3.S1depth: emit _depth leaked to ${bus._depth} after post-shutdown throw`);
        let sfThrew = false;
        try { bus.emitSafe('e', 1); } catch (e) { sfThrew = /shut down/i.test(e.message); }
        check(sfThrew, () => 'T3.S1depth: post-shutdown emitSafe did not fail closed');
        check(bus._depth === 0, () => `T3.S1depth: emitSafe _depth leaked to ${bus._depth} after post-shutdown throw`);
    }
}
