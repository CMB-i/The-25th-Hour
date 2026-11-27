// The one place the plan asks "what time is it?". Tests (and anyone replaying a moment) can override it.
let provider = () => new Date();

/** Current time as a Date. Everything that decides what has already elapsed calls this. */
export function getNow() {
  return provider();
}

/** Override the clock: pass a function returning a Date, a Date, an ISO string, or null to restore the browser clock. */
export function setNowProvider(source) {
  if (source === null || source === undefined) provider = () => new Date();
  else if (typeof source === 'function') provider = () => new Date(source());
  else provider = () => new Date(source);
}
