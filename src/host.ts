// ---------------------------------------------------------------------------
// The host: what production code takes its platform from, so that a test
// can hand it a simulated one. This module imports nothing, and is
// published as `stifinder/host`: importing it puts none of the search in a
// production bundle.
//
// Production code takes a `Host` as an argument and uses it where it would
// use the globals: `host.fetch`, `host.setTimeout`, `host.random`. In
// production that host is `webHost()`, the platform itself. Under
// `program()` (see system.ts) it is the simulated one, whose answers and
// timers the search explores.
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
/** A timer the host set. Opaque: it is only for clearing. */
export interface Timer {
  readonly [brand]: 'Timer';
}

/** The platform, as the code under test sees it. Every member is a
 *  function of its own, so that code may take the ones it uses apart:
 *  `({ fetch, setTimeout }: Host) => ...`. */
export interface Host {
  /** As `globalThis.fetch`. */
  fetch: typeof globalThis.fetch;
  /** As `globalThis.setTimeout`, without the extra arguments. */
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  /** As `globalThis.setInterval`, without the extra arguments. */
  setInterval: (callback: () => void, ms: number) => Timer;
  clearInterval: (timer: Timer) => void;
  /** A signal that aborts after `ms`, as `AbortSignal.timeout(ms)`. */
  timeoutSignal: (ms: number) => AbortSignal;
  /** A number in [0, 1), as `Math.random()`. */
  random: () => number;
  /** A UUID, as `crypto.randomUUID()`. */
  uuid: () => string;
}

/** The platform itself: the host of production code. */
export function webHost(): Host {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as Timer,
    clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as number),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown as Timer,
    clearInterval: (timer) => globalThis.clearInterval(timer as unknown as number),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    random: () => Math.random(),
    uuid: () => crypto.randomUUID(),
  };
}
