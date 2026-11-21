// A library loaded on first use instead of when the server starts (decision #256). The server's start was mostly
// spent loading files: about 3,600 modules, most of them for things only a tool or an upload needs (spreadsheets,
// slides, Word files, mail, feed discovery). lazy(() => import('x')) returns a function that loads it once and hands
// back the same promise after; a failed load isn't kept, so the next call tries again.
export function lazy(load) {
  let pending = null;
  return () => (pending ??= load().catch(err => { pending = null; throw err; }));
}
