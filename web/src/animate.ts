// Tweening a displayed degree value, instead of snapping straight to it.
//
// A hero number that jumps from 68 to 92 as the slider is dragged reads as a glitch; a
// short tween of the same jump reads as a live instrument. The previous value lives on
// the element itself (`dataset.value`), so this needs no state beyond the DOM node it is
// given, and it degrades to an instant set for anyone who asked for less motion.

const reduceMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function tweenDegrees(element: HTMLElement, value: number | null, duration = 380): void {
  if (value === null) {
    element.textContent = '—';
    delete element.dataset.value;
    return;
  }

  const target = Math.round(value);
  const previous = Number(element.dataset.value);
  element.dataset.value = String(target);

  if (reduceMotion || !Number.isFinite(previous) || previous === target) {
    element.textContent = `${target}°`;
    return;
  }

  const start = performance.now();
  const from = previous;

  function tick(now: number): void {
    // Only the most recent tween on this element should ever be finishing; a value that
    // moved again mid-flight has already overwritten `dataset.value` above.
    if (Number(element.dataset.value) !== target) return;
    const elapsed = (now - start) / duration;
    const t = Math.min(1, elapsed);
    const eased = 1 - (1 - t) * (1 - t); // ease-out
    element.textContent = `${Math.round(from + (target - from) * eased)}°`;
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
