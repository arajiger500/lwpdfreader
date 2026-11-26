import type { InkPoint, Stabilization } from './ink-types';

const amount = { off: 0, low: 0.5, medium: 1, high: 1.55 };
const alpha = (elapsed: number, timeConstant: number) => 1 - Math.exp(-elapsed / timeConstant);

/** Motion-adaptive exponential filter in CSS pixels. Limit positional lag
 * explicitly so small lettering and fast direction changes retain their shape. */
export class InkFilter {
  private raw?: InkPoint;
  private output?: InkPoint;
  private time = 0;
  private speed = 0;
  constructor(
    private level: Stabilization,
    private width: number,
    private height: number,
  ) {}

  sample(point: InkPoint, timestamp: number, terminal = false): InkPoint {
    const previous = this.raw;
    const output = this.output;
    const elapsed = Math.max(2, Math.min(32, timestamp - this.time));
    const strength = amount[this.level];
    this.raw = point;
    this.time = timestamp;
    if (!previous || !output || !strength) return (this.output = point);
    const speed =
      Math.hypot((point.x - previous.x) * this.width, (point.y - previous.y) * this.height) /
      elapsed;
    this.speed += (speed - this.speed) * alpha(elapsed, 10);
    const gain = terminal ? 1 : alpha(elapsed, (23 * strength) / (1 + 5 * this.speed));
    const dx = (point.x - output.x) * (1 - gain);
    const dy = (point.y - output.y) * (1 - gain);
    const lag = Math.hypot(dx * this.width, dy * this.height);
    const limit = lag ? Math.min(1, (1.2 * strength) / lag) : 1;
    const pressure =
      point.pressure === null || output.pressure === null
        ? point.pressure
        : output.pressure + (point.pressure - output.pressure) * alpha(elapsed, 11 * strength);
    return (this.output = { x: point.x - dx * limit, y: point.y - dy * limit, pressure });
  }
}
