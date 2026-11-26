// Synthetic inputs in CSS pixels, sampled at 120 Hz. No browser/device timing claims.
import { InkFilter } from '../src/lib/ink-filter.ts';

const diameter = 1024;
const gains = ['baseline', 'one-euro', 'off', 'low', 'medium', 'high'];
const dt = 1 / 120;
const smoothing = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
function oneEuro() {
  let signal;
  return (raw) => {
    if (!signal) {
      signal = { raw, filtered: raw, vx: 0, vy: 0 };
      return raw;
    }
    const vx = signal.vx + smoothing(1) * (((raw.x - signal.raw.x) * diameter) / dt - signal.vx);
    const vy = signal.vy + smoothing(1) * (((raw.y - signal.raw.y) * diameter) / dt - signal.vy);
    const gain = smoothing(2 + 0.15 * Math.hypot(vx, vy));
    const filtered = {
      ...raw,
      x: signal.filtered.x + gain * (raw.x - signal.filtered.x),
      y: signal.filtered.y + gain * (raw.y - signal.filtered.y),
    };
    signal = { raw, filtered, vx, vy };
    return filtered;
  };
}
const rows = gains.map((mode) => {
  const filter = new InkFilter(
    mode === 'baseline' || mode === 'one-euro' ? 'off' : mode,
    diameter,
    diameter,
  );
  const euro = oneEuro();
  let last;
  let jitterSum = 0,
    cornerMax = 0,
    pressureJump = 0,
    driftX = 0,
    driftY = 0;
  for (let i = 0; i < 300; ++i) {
    const quiet = i < 120;
    const x = quiet ? 50 + i * 0.3 : 86 + (i < 200 ? (i - 120) * 3 : 240);
    const y = i < 200 ? 100 : 100 + (i - 200) * 3;
    const signal = quiet ? (i % 2 ? 0.65 : -0.65) : 0;
    const raw = {
      x: (x + signal) / diameter,
      y: (y - signal) / diameter,
      pressure: i < 140 ? 0.2 : 0.9,
    };
    const out =
      mode === 'one-euro'
        ? euro(raw)
        : mode !== 'baseline'
          ? filter.sample(raw, (i * 1000) / 120)
          : {
              ...raw,
              x: last ? last.x + 0.65 * (raw.x - last.x) : raw.x,
              y: last ? last.y + 0.65 * (raw.y - last.y) : raw.y,
            };
    const dx = out.x * diameter - x;
    const dy = out.y * diameter - y;
    const error = Math.hypot(dx, dy);
    if (quiet) {
      jitterSum += error * error;
      driftX += dx;
      driftY += dy;
    } else if (i >= 198 && i <= 205) cornerMax = Math.max(cornerMax, error);
    if (last) pressureJump = Math.max(pressureJump, Math.abs(out.pressure - last.pressure));
    last = out;
  }
  return {
    mode,
    jitterAroundMeanPx: Math.sqrt(
      Math.max(0, jitterSum / 120 - (driftX / 120) ** 2 - (driftY / 120) ** 2),
    ),
    slowRmsErrorPx: Math.sqrt(jitterSum / 120),
    fastCornerMaxErrorPx: cornerMax,
    maxPressureStep: pressureJump,
  };
});
console.log(
  JSON.stringify(
    {
      samplesPerSecond: 120,
      oneEuro: { minCutoffHz: 2, speedGain: 0.15, derivativeCutoffHz: 1 },
      rows,
    },
    null,
    2,
  ),
);
