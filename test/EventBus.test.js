// @zakkster/lite-di-event-bus -- node:test suite.
// Behavioural coverage; the allocation and retention gates live in test/torture.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { EventBus, VERSION, OPTIONS } from '../EventBus.js';

test('VERSION is a three-place-synced string', () => {
    assert.equal(typeof VERSION, 'string');
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('OPTIONS is frozen and lists only onError', () => {
    assert.deepEqual([...OPTIONS], ['onError']);
    assert.ok(Object.isFrozen(OPTIONS));
});

test('constructor requires a container', () => {
    assert.throws(() => new EventBus(null), /container is required/);
    assert.throws(() => new EventBus(undefined), /container is required/);
});

test('emit dispatches to every listener in registration order', () => {
    const c = new Container();
    const bus = new EventBus(c);
    const log = [];
    class A { handle(p) { log.push('a' + p); } }
    class B { handle(p) { log.push('b' + p); } }
    bus.on('e', A).on('e', B);
    bus.boot();
    bus.emit('e', 1);
    assert.deepEqual(log, ['a1', 'b1']);
});

test('DI-constructed listeners receive injected deps', () => {
    const c = new Container();
    const bus = new EventBus(c);
    c.value('cfg', { tag: 'T' });
    let seen;
    class L { constructor(cfg) { this.cfg = cfg; } handle(p) { seen = this.cfg.tag + p; } }
    bus.on('e', L, ['cfg']);
    bus.boot();
    bus.emit('e', 'x');
    assert.equal(seen, 'Tx');
});

test('listenerCount reflects registration count', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L).on('e', L).on('e', L);
    bus.boot();
    assert.equal(bus.listenerCount('e'), 3);
    assert.equal(bus.listenerCount('absent'), 0);
});

test('the shared buffer is sized to the largest listener count', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('a', L);
    bus.on('b', L).on('b', L).on('b', L).on('b', L);
    bus.boot();
    assert.equal(bus._bufStack[0].length, 4);
    assert.doesNotThrow(() => { bus.emit('b', 1); bus.emit('a', 1); });
});

test('unknown option throws with a did-you-mean hint (A4)', () => {
    const c = new Container();
    assert.throws(() => new EventBus(c, { onErr() {} }),
        /Unknown option 'onErr'.*'onError'/);
});

test('a valid onError option is accepted; a non-function is rejected', () => {
    const c = new Container();
    assert.doesNotThrow(() => new EventBus(c, { onError() {} }));
    assert.throws(() => new EventBus(c, { onError: 7 }), TypeError);
});

test('on() after boot throws a topology violation', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    assert.throws(() => bus.on('e', L), /after boot|topology/);
});

test('register -> boot -> emit -> shutdown -> emit throws (A2)', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    let calls = 0;
    class L { handle() { calls++; } }
    bus.on('e', L);
    bus.boot();
    bus.emit('e', 1);
    assert.equal(calls, 1);
    await c.shutdown();
    assert.throws(() => bus.emit('e', 2), /shut down/i);
    assert.equal(calls, 1);
    await assert.doesNotReject(c.shutdown()); // second shutdown is a no-op
});

test('emitSafe isolates a throwing listener and routes to onError', () => {
    const c = new Container();
    const errs = [];
    const bus = new EventBus(c, { onError: (e, ev, name) => errs.push(ev + '/' + name) });
    let after = 0;
    class Boom { handle() { throw new Error('boom'); } }
    class Ok { handle() { after++; } }
    bus.on('e', Boom).on('e', Ok);
    bus.boot();
    bus.emitSafe('e', 1);
    assert.equal(after, 1);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /Boom/);
});

test('emitAsync awaits every listener in order', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    const order = [];
    class L1 { async handle() { await Promise.resolve(); order.push(1); } }
    class L2 { async handle() { await Promise.resolve(); order.push(2); } }
    bus.on('e', L1).on('e', L2);
    bus.boot();
    await bus.emitAsync('e', 0);
    assert.deepEqual(order, [1, 2]);
});

test('overlapping emitAsync calls on different events do not cross buffers (S1)', async () => {
    // Two overlapping (NOT nested) emitAsync calls share one bus buffer. The
    // second call's synchronous getAllInto must not corrupt the first call's
    // in-flight dispatch. Each listener must fire exactly once with ITS payload.
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
    assert.equal(count('A1/PA'), 1, 'A1 fired once with PA');
    assert.equal(count('A2/PA'), 1, 'A2 fired once with PA');
    assert.equal(count('B1/PB'), 1, 'B1 fired once with PB');
    assert.equal(count('B2/PB'), 1, 'B2 fired once with PB');
    assert.equal(log.length, 4, 'exactly four dispatches, no doubles, no drops');
});

test('dispose() releases state and makes emit/on fail closed', async () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    await c.shutdown();
    bus.dispose();
    assert.equal(bus._bufStack, null);
    assert.equal(bus._container, null);
    // Every public surface fails closed with a clean guarded message -- not a raw NPE.
    assert.throws(() => bus.emit('e', 1), /disposed/);
    assert.throws(() => bus.emitSafe('e', 1), /disposed/);
    await assert.rejects(() => bus.emitAsync('e', 1), /disposed/);
    assert.throws(() => bus.on('e', L), /disposed/);
    assert.throws(() => bus.boot(), /disposed/);
    assert.throws(() => bus.listenerCount('e'), /disposed/);
});

test('emit on an unregistered event falls through to a container throw', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('known', L);
    bus.boot();
    assert.throws(() => bus.emit('unknown', 1), /not registered/i);
});

test('boot() is idempotent', () => {
    const c = new Container();
    const bus = new EventBus(c);
    class L { handle() {} }
    bus.on('e', L);
    bus.boot();
    const stack = bus._bufStack;
    bus.boot();
    assert.equal(bus._bufStack, stack);
});
