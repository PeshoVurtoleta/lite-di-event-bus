/**
 * T5 -- differential fuzz over random listener topologies (A6).
 *
 * 32 seeds x 2000 iterations. Each seed materialises a random topology (a random
 * set of events, each with a random listener count) into a Container + EventBus,
 * boots it, then replays random emits. The invariant checked every iteration:
 *
 *   the count getAllInto writes into the bus buffer === getAll(name).length,
 *   and the shared buffer NEVER RangeErrors (it is sized to the largest count).
 *
 * A RangeError here would mean bus.boot() mis-sized the shared buffer -- the
 * exact failure D-EB2 exists to make unreachable. On any divergence the seed and
 * iteration are printed for replay.
 */

import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '../../EventBus.js';
import { SEED, makePrng, die } from './harness.mjs';

const SEEDS = 32;
const ITERS = 2000;

function buildTopology(rnd) {
    const c = new Container();
    const bus = new EventBus(c);
    const events = [];
    const nEvents = 1 + (rnd() % 6);
    let max = 0;
    for (let e = 0; e < nEvents; e++) {
        const name = 'ev' + e;
        const listeners = 1 + (rnd() % 8);
        if (listeners > max) max = listeners;
        for (let i = 0; i < listeners; i++) {
            class L { handle() {} }
            bus.on(name, L);
        }
        events.push(name);
    }
    bus.boot();
    return { c, bus, events, max };
}

// Cap must match EventBus.MAX_DEPTH; nested depth stays strictly within it so
// the topology never trips the nesting guard (that path is covered by T3.A9).
const MAX_DEPTH = 8;

// A random cascade: level k's first listener synchronously emits level k+1, so
// each level fires exactly once per top-level emit and the payload threads all
// the way down. Every listener records its id + the payload it received.
function buildNested(rnd) {
    const c = new Container();
    const bus = new EventBus(c);
    c.value('bus', bus);
    const state = { ids: [], payloads: [] };
    const depth = 1 + (rnd() % MAX_DEPTH); // 1..8, never exceeds the cap
    let expected = 0;
    for (let k = 0; k < depth; k++) {
        const level = 'lvl' + k;
        const r = 1 + (rnd() % 4);
        expected += r;
        const nextLevel = k < depth - 1 ? 'lvl' + (k + 1) : null;
        for (let j = 0; j < r; j++) {
            const id = k + '_' + j;
            const next = j === 0 ? nextLevel : null; // first listener cascades
            class L {
                constructor(b) { this.bus = b; }
                handle(p) {
                    state.ids.push(id);
                    state.payloads.push(p);
                    if (next !== null) this.bus.emit(next, p);
                }
            }
            bus.on(level, L, ['bus']);
        }
    }
    bus.boot();
    return { c, bus, state, expected, depth };
}

export async function run() {
    let s = (SEED >>> 0) || 1;

    for (let seed = 0; seed < SEEDS; seed++) {
        s = (s * 1664525 + 1013904223) >>> 0 || 1;
        const rnd = makePrng(s);
        const { c, bus, events, max } = buildTopology(rnd);

        for (let it = 0; it < ITERS; it++) {
            const name = events[rnd() % events.length];

            let count = -1;
            try {
                count = c.getAllInto(name, bus._bufStack[0]);
            } catch (e) {
                if (e instanceof RangeError) {
                    die('T5 fuzz: RangeError through the shared buffer at seed=' + s +
                        ' iter=' + it + ' event=' + name + ' bufLen=' + bus._bufStack[0].length + ' max=' + max);
                }
                throw e;
            }

            const expected = c.getAll(name).length;
            if (count !== expected) {
                die('T5 fuzz: buffer count ' + count + ' != getAll().length ' + expected +
                    ' at seed=' + s + ' iter=' + it + ' event=' + name);
            }
            if (bus.listenerCount(name) !== expected) {
                die('T5 fuzz: listenerCount ' + bus.listenerCount(name) + ' != ' + expected +
                    ' at seed=' + s + ' iter=' + it + ' event=' + name);
            }

            // A real emit must not throw on a live, booted topology.
            bus.emit(name, it);
        }

        await c.shutdown();
    }

    // ---- A11: random NESTED topologies -- never RangeError, never crossed ---
    for (let seed = 0; seed < SEEDS; seed++) {
        s = (s * 1664525 + 1013904223) >>> 0 || 1;
        const rnd = makePrng(s);
        const { c, bus, state, expected, depth } = buildNested(rnd);

        for (let it = 0; it < ITERS; it++) {
            state.ids.length = 0;
            state.payloads.length = 0;
            const payload = (rnd() % 1000000) >>> 0;

            try {
                bus.emit('lvl0', payload);
            } catch (e) {
                if (e instanceof RangeError) {
                    die('T5 nested: RangeError at seed=' + s + ' iter=' + it + ' depth=' + depth);
                }
                throw e;
            }

            if (state.ids.length !== expected) {
                die('T5 nested: dispatched ' + state.ids.length + ' != expected ' + expected +
                    ' at seed=' + s + ' iter=' + it + ' depth=' + depth);
            }
            if (new Set(state.ids).size !== expected) {
                die('T5 nested: a listener fired more than once at seed=' + s + ' iter=' + it +
                    ' (ids=' + state.ids.join(',') + ')');
            }
            for (let i = 0; i < state.payloads.length; i++) {
                if (state.payloads[i] !== payload) {
                    die('T5 nested: wrong-payload delivery ' + state.payloads[i] + ' != ' + payload +
                        ' at seed=' + s + ' iter=' + it + ' depth=' + depth);
                }
            }
            if (bus._depth !== 0) {
                die('T5 nested: _depth not restored to 0 (=' + bus._depth + ') at seed=' + s + ' iter=' + it);
            }
        }

        await c.shutdown();
    }

    process.stderr.write('T5 fuzz: ' + (SEEDS * ITERS) + ' flat + ' + (SEEDS * ITERS) +
        ' nested iters clean across ' + SEEDS + ' seeds\n');
}
