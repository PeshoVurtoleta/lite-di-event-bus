# Cookbook -- @zakkster/lite-di-event-bus

Recipes, beginner to pro. This is a stub for the alpha; it grows alongside the
`@zakkster/lite-di-*` dependents line. Every snippet is runnable against the
shipped `@zakkster/lite-di-container` v2.0.0 surface.

## 1. A minimal fan-out

```javascript
import { Container } from '@zakkster/lite-di-container';
import { EventBus } from '@zakkster/lite-di-event-bus';

class Greeter { handle(name) { console.log('hello ' + name); } }

const c = new Container();
const bus = new EventBus(c);
bus.on('greet', Greeter);
bus.boot();
bus.emit('greet', 'world');   // hello world
```

## 2. Handlers with injected dependencies

Listeners are DI-constructed, so they receive their own deps by name:

```javascript
class Audit {
  constructor(clock) { this.clock = clock; }
  handle(event) { /* this.clock.now() ... */ }
}

c.value('clock', { now: () => Date.now() });
bus.on('order.placed', Audit, ['clock']);
```

## 3. Isolating a flaky listener

`emit` lets a throwing handler propagate (fail fast). `emitSafe` isolates each
one and routes the error to your `onError`:

```javascript
const bus = new EventBus(c, {
  onError: (err, eventName, listenerName) => report(err, eventName, listenerName),
});
bus.emitSafe('order.placed', payload);   // one bad listener never stops the rest
```

## 4. Async handlers

`emitAsync` awaits each listener in registration order. It is NOT a zero-GC path
(awaiting allocates promise machinery); use `emit` on hot paths.

```javascript
class Notify { async handle(order) { await sendEmail(order); } }
bus.on('order.placed', Notify);
bus.boot();
await bus.emitAsync('order.placed', order);
```

## 5. Fail-closed lifecycle

```javascript
bus.boot();
bus.emit('e', 1);            // ok
await c.shutdown();
bus.emit('e', 2);            // throws: Container shut down (never dispatches to torn-down instances)
```

## 6. Static topology discipline

All `on()` calls happen before boot. Registering after boot is a topology
violation:

```javascript
bus.boot();
bus.on('e', Late);           // throws: static topology violation
```
