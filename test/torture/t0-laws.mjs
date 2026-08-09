/**
 * T0 -- event-bus dispatch laws.
 *
 * Properties that must hold for ANY topology, checked over a seeded corpus.
 * These are the observable contract of the bus: DI-constructed handlers,
 * dispatch by registration order, count fidelity, config fail-closed, and the
 * unknown-event fall-through to the container's own throw.
 */

import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '../../EventBus.js';
import { makePrng, SEED, check } from './harness.mjs';

export async function run() {
    const prng = makePrng(SEED);

    // -- Law 1: dispatch reaches every listener, in registration order --------
    {
        const c = new Container();
        const bus = new EventBus(c);
        const log = [];
        class A { handle(p) { log.push('A' + p); } }
        class B { handle(p) { log.push('B' + p); } }
        class D { handle(p) { log.push('D' + p); } }
        bus.on('e', A).on('e', B).on('e', D);
        bus.boot();
        bus.emit('e', 1);
        check(log.length === 3, () => `T0.dispatch: expected 3 calls, got ${log.length}`);
        check(log[0] === 'A1' && log[1] === 'B1' && log[2] === 'D1',
            () => `T0.dispatch: order wrong: ${log.join(',')}`);
    }

    // -- Law 2: DI-constructed handlers receive their injected deps -----------
    {
        const c = new Container();
        const bus = new EventBus(c);
        c.value('prefix', '>>');
        let seen = null;
        class L {
            constructor(prefix) { this.prefix = prefix; }
            handle(p) { seen = this.prefix + p; }
        }
        bus.on('e', L, ['prefix']);
        bus.boot();
        bus.emit('e', 'x');
        check(seen === '>>x', () => `T0.deps: injected dep not applied, got ${seen}`);
    }

    // -- Law 3: singleton listeners -- one instance across many emits ---------
    {
        const c = new Container();
        const bus = new EventBus(c);
        let built = 0;
        let calls = 0;
        class L { constructor() { built++; } handle() { calls++; } }
        bus.on('e', L);
        bus.boot();
        for (let i = 0; i < 100; i++) bus.emit('e', i);
        check(built === 1, () => `T0.singleton: listener built ${built} times, expected 1`);
        check(calls === 100, () => `T0.singleton: handler fired ${calls} times, expected 100`);
    }

    // -- Law 4: listenerCount fidelity == getAllInto count == getAll().length -
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        const N = 5;
        for (let i = 0; i < N; i++) bus.on('e', L);
        bus.boot();
        check(bus.listenerCount('e') === N, () => `T0.count: listenerCount ${bus.listenerCount('e')} != ${N}`);
        check(bus.listenerCount('absent') === 0, () => 'T0.count: absent event should count 0');
        const out = new Array(N);
        const written = c.getAllInto('e', out);
        check(written === c.getAll('e').length, () => 'T0.count: getAllInto count != getAll().length');
        check(written === N, () => `T0.count: getAllInto wrote ${written}, expected ${N}`);
    }

    // -- Law 5: unknown event falls through to the container throw ------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('known', L);
        bus.boot();
        let threw = false;
        try { bus.emit('unknown', 1); } catch (e) { threw = /not registered|available/i.test(e.message); }
        check(threw, () => 'T0.unknown: emit on an unregistered event did not fall through to a container throw');
    }

    // -- Law 6: config is fail-closed with a did-you-mean hint (A4) -----------
    {
        const c = new Container();
        let msg = '';
        try { new EventBus(c, { onErr() {} }); } catch (e) { msg = e.message; }
        check(/Unknown option 'onErr'/.test(msg) && /'onError'/.test(msg),
            () => `T0.config: did-you-mean missing, got: ${msg}`);
        // A valid option is accepted.
        let ok = true;
        try { new EventBus(c, { onError() {} }); } catch { ok = false; }
        check(ok, () => 'T0.config: a valid onError option was rejected');
        // A non-function onError fails closed.
        let te = false;
        try { new EventBus(c, { onError: 7 }); } catch (e) { te = e instanceof TypeError; }
        check(te, () => 'T0.config: a non-function onError was not rejected');
    }

    // -- Law 7: boot sizes the shared buffer to the LARGEST listener count ----
    {
        const c = new Container();
        const bus = new EventBus(c);
        class L { handle() {} }
        bus.on('small', L);
        bus.on('big', L).on('big', L).on('big', L);
        bus.boot();
        check(bus._bufStack[0].length === 3, () => `T0.sizing: buffer length ${bus._bufStack[0].length}, expected 3`);
        // The largest event never RangeErrors through the shared buffer.
        let ok = true;
        try { bus.emit('big', 1); bus.emit('small', 1); } catch { ok = false; }
        check(ok, () => 'T0.sizing: emit RangeErrored through the shared buffer');
    }

    // -- Law 8: emitSafe isolates a throwing listener, routes to onError ------
    {
        const c = new Container();
        const errs = [];
        const bus = new EventBus(c, { onError: (e, ev, name) => errs.push(ev + '/' + name) });
        let after = 0;
        class Boom { handle() { throw new Error('boom'); } }
        class Ok { handle() { after++; } }
        bus.on('e', Boom).on('e', Ok);
        bus.boot();
        bus.emitSafe('e', 1);
        check(after === 1, () => 'T0.emitSafe: dispatch did not continue past a throwing listener');
        check(errs.length === 1 && /Boom/.test(errs[0]), () => `T0.emitSafe: onError not routed: ${errs.join(',')}`);
    }

    // -- Law 9: emitAsync awaits every listener --------------------------------
    {
        const c = new Container();
        const bus = new EventBus(c);
        const order = [];
        class L1 { async handle() { await Promise.resolve(); order.push(1); } }
        class L2 { async handle() { await Promise.resolve(); order.push(2); } }
        bus.on('e', L1).on('e', L2);
        bus.boot();
        await bus.emitAsync('e', 0);
        check(order.length === 2 && order[0] === 1 && order[1] === 2,
            () => `T0.emitAsync: sequential order wrong: ${order.join(',')}`);
    }

    // -- A seeded random-topology corpus, dispatch fidelity re-checked --------
    for (let g = 0; g < 40; g++) {
        const c = new Container();
        const bus = new EventBus(c);
        const nEvents = 1 + (prng() % 4);
        const counts = new Map();
        const log = new Map();
        for (let e = 0; e < nEvents; e++) {
            const name = 'ev' + e;
            const listeners = 1 + (prng() % 6);
            counts.set(name, listeners);
            log.set(name, 0);
            for (let i = 0; i < listeners; i++) {
                const key = name;
                class L { handle() { log.set(key, log.get(key) + 1); } }
                bus.on(name, L);
            }
        }
        bus.boot();
        for (const [name, n] of counts) {
            check(bus.listenerCount(name) === n,
                () => `T0.corpus: graph ${g} count ${bus.listenerCount(name)} != ${n} (seed=${SEED})`);
            bus.emit(name, 1);
            check(log.get(name) === n,
                () => `T0.corpus: graph ${g} dispatched ${log.get(name)} != ${n} (seed=${SEED})`);
        }
    }
}
