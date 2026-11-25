/**
 * Rate-limits a stream of values per key: `flush` gets the latest value of each key at most once
 * every `intervalMs`. Used to keep the browser updated without sending every joystick line.
 */
export function coalesce<K, V>(intervalMs: number, flush: (value: V) => void): (key: K, value: V) => void {
  const pending = new Map<K, V>();
  let timer: NodeJS.Timeout | null = null;
  return (key, value) => {
    pending.set(key, value);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const values = [...pending.values()];
      pending.clear();
      for (const v of values) flush(v);
    }, intervalMs);
  };
}
