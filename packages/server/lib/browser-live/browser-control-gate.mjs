export class BrowserControlGate {
  constructor() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  assertAgentControl() {
    if (!this.paused) return;
    const error = new Error("Browser control belongs to the WebApp user. Wait until control is explicitly returned.");
    error.code = "BROWSER_USER_CONTROLLING";
    throw error;
  }
}

export function guardedObject(value, gate, cache = new WeakMap()) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (value instanceof Promise) {
    return value.then((resolved) => guardedObject(resolved, gate, cache));
  }
  const cached = cache.get(value);
  if (cached) return cached;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      if (property === "then") return Reflect.get(target, property, receiver);
      const member = Reflect.get(target, property, receiver);
      if (typeof member === "function") {
        return (...args) => {
          gate.assertAgentControl();
          return guardedObject(Reflect.apply(member, target, args), gate, cache);
        };
      }
      return guardedObject(member, gate, cache);
    },
  });
  cache.set(value, proxy);
  return proxy;
}
