// The time slider. A native range input, so arrow keys, Home and End work for free.

import { hourLabel } from './format';
import type { Manifest } from './types';

export interface SliderView {
  render(hour: number): void;
}

export function createSlider(
  root: HTMLElement,
  manifest: Manifest,
  onChange: (hour: number) => void,
): SliderView {
  const last = manifest.forecast_times.length - 1;
  root.innerHTML = `
    <div class="slider-row">
      <label class="visually-hidden" for="hour">Forecast hour</label>
      <input
        type="range"
        id="hour"
        min="0"
        max="${last}"
        step="1"
        value="0"
        aria-describedby="hour-readout"
      />
    </div>
    <p class="slider-readout" id="hour-readout" aria-live="polite"></p>
    <p class="slider-hint">Moving this changes every temperature on the page.</p>
  `;

  const input = root.querySelector('#hour') as HTMLInputElement;
  const readout = root.querySelector('#hour-readout') as HTMLElement;

  input.addEventListener('input', () => onChange(Number(input.value)));

  function render(hour: number): void {
    if (Number(input.value) !== hour) input.value = String(hour);
    const stamp = manifest.forecast_times[hour];
    const label = stamp ? hourLabel(stamp) : '';
    readout.textContent = label;
    // The visible readout is the accessible one too, so a screen reader hears the same
    // hour a sighted reader sees rather than "14 of 23".
    input.setAttribute('aria-valuetext', label);
  }

  return { render };
}
