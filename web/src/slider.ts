// The time slider. A native range input, so arrow keys, Home and End work for free — plus
// a play button, because a bare slider with a caption explaining what it does is a puzzle,
// not a control. Press play and the forecast animates itself; the reader learns the
// mechanism by watching it run, not by reading about it.
//
// The selected-hour label sits on its own line above the track, not beside it — a fixed
// label width next to the track was eating a large share of a mobile card's horizontal
// space, leaving little for the one thing a reader actually drags. Below the label: play
// button, track, sparse anchors under the track. This is the single control behind the
// hero, the map and the chart's cursor — see Priority 6 — so it never resets on its own
// when a place changes or a frame loads.

import { localHour, weekdayHourLong } from './format';
import type { Manifest } from './types';

export interface SliderView {
  render(hour: number): void;
  /** Stops autoplay. Called when the reader picks a new place, so the animation never
   * keeps running past the moment that motivated it — see Priority 6. */
  stop(): void;
}

const STEP_MS = 550;

export function createSlider(
  root: HTMLElement,
  manifest: Manifest,
  onChange: (hour: number) => void,
): SliderView {
  const times = manifest.forecast_times;
  const last = times.length - 1;
  root.innerHTML = `
    <p class="slider-readout" id="hour-readout" aria-live="polite"></p>
    <div class="slider-row">
      <button type="button" class="slider-play" id="slider-play" aria-label="Play the next 24 hours">
        <span class="slider-play-icon" aria-hidden="true"></span>
      </button>
      <div class="slider-track-wrap">
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
        <div class="slider-anchors" aria-hidden="true">${anchors(times, last)}</div>
      </div>
    </div>
  `;

  const input = root.querySelector('#hour') as HTMLInputElement;
  const readout = root.querySelector('#hour-readout') as HTMLElement;
  const playButton = root.querySelector('#slider-play') as HTMLButtonElement;

  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    playButton.classList.remove('playing');
    playButton.setAttribute('aria-label', 'Play the next 24 hours');
  }

  function play(): void {
    // Restart from the beginning if paused at the end — pressing play at hour 23 should
    // watch the forecast again, not sit there doing nothing.
    if (Number(input.value) >= last) onChange(0);
    playButton.classList.add('playing');
    playButton.setAttribute('aria-label', 'Pause');
    timer = setInterval(() => {
      const next = Number(input.value) + 1;
      if (next > last) {
        stop();
        return;
      }
      onChange(next);
    }, STEP_MS);
  }

  playButton.addEventListener('click', () => {
    if (timer === null) play();
    else stop();
  });

  // Dragging the slider by hand is its own kind of play; do not fight it with a timer
  // that jumps the thumb out from under the reader's finger. Selecting a new place also
  // stops it — see the caller in main.ts, which stops playback before any other update.
  input.addEventListener('input', () => {
    stop();
    onChange(Number(input.value));
  });

  function render(hour: number): void {
    if (Number(input.value) !== hour) input.value = String(hour);
    const stamp = times[hour];
    const label = stamp ? weekdayHourLong(stamp) : '';
    readout.textContent = label;
    // The visible readout is the accessible one too, so a screen reader hears the same
    // hour a sighted reader sees rather than "14 of 23".
    input.setAttribute('aria-valuetext', label);
  }

  return { render, stop };
}

/** Start, the first midnight, the first noon and the endpoint — sparse anchors rather
 * than a label per hour, positioned at their real fraction of the track. */
function anchors(times: string[], last: number): string {
  if (last <= 0) return '';
  const marks = new Map<number, string>();
  marks.set(0, 'Start');
  const midnight = times.findIndex((stamp, index) => index > 0 && localHour(stamp) === 0);
  if (midnight > 0 && midnight < last) marks.set(midnight, 'Midnight');
  const noon = times.findIndex((stamp) => localHour(stamp) === 12);
  if (noon > 0 && noon < last && !marks.has(noon)) marks.set(noon, 'Noon');
  marks.set(last, 'End');

  return [...marks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, label]) => `<span style="left:${(index / last) * 100}%">${label}</span>`)
    .join('');
}
