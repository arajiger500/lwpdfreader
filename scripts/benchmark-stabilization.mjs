// Synthetic inputs in CSS pixels, sampled at 120 Hz. No browser/device timing claims.
import { InkFilter } from '../src/lib/ink-filter.ts';

const diameter = 1024;
const gains = ['baseline', 'off', 'low', 'medium', 'high'];
const rows = gains.map((mode) => {
  const filter = new InkFilter(mode === 'baseline' ? 'off' : mode, diameter, diameter);
  let last;
  let jitterSum = 0,
    cornerMax = 0,
    pressureJump = 0;
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
      mode !== 'baseline'
        ? filter.sample(raw, (i * 1000) / 120)
        : {
            ...raw,
            x: last ? last.x + 0.65 * (raw.x - last.x) : raw.x,
            y: last ? last.y + 0.65 * (raw.y - last.y) : raw.y,
          };
    const error = Math.hypot(out.x * diameter - x, out.y * diameter - y);
    if (quiet) jitterSum += error * error;
    else if (i >= 198 && i <= 205) cornerMax = Math.max(cornerMax, error);
    if (last) pressureJump = Math.max(pressureJump, Math.abs(out.pressure - last.pressure));
    last = out;
  }
  return {
    mode,
    slowRmsErrorPx: Math.sqrt(jitterSum / 120),
    fastCornerMaxErrorPx: cornerMax,
    maxPressureStep: pressureJump,
  };
});
console.log(JSON.stringify({ samplesPerSecond: 120, rows }, null, 2));
