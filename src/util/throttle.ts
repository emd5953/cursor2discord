/**
 * Trailing-edge debounce: calls `fn` once, `ms` after the last invocation.
 */
export function debounce<T>(fn: (value: T) => void, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  let last: T;

  const invoke = () => {
    timer = undefined;
    fn(last);
  };

  const wrapped = (value: T) => {
    last = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(invoke, ms);
  };

  wrapped.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    invoke();
  };

  wrapped.cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  return wrapped;
}
