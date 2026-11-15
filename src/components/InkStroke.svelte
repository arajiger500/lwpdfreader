<script lang="ts">
  import type { Stroke } from '../lib/ink-types';
  import { strokePath } from '../lib/ink-geometry';
  let { stroke, box }: { stroke: Stroke; box: number[] } = $props();
  const path = $derived(strokePath(stroke, box));
  const width = $derived(stroke.width * Math.min(box[2] - box[0], box[3] - box[1]));
  const pressure = $derived(
    stroke.kind === 'pen' && stroke.points.some((p) => p.pressure !== null),
  );
</script>

{#if stroke.points.length === 1 && !pressure}
  <circle
    data-stroke={stroke.id}
    cx={box[0] + stroke.points[0].x * (box[2] - box[0])}
    cy={box[1] + stroke.points[0].y * (box[3] - box[1])}
    r={width / 2}
    fill={stroke.color}
  />
{:else}<path
    data-stroke={stroke.id}
    d={path}
    fill={pressure ? stroke.color : 'none'}
    stroke={pressure ? 'none' : stroke.color}
    stroke-width={width}
    stroke-linecap="round"
    stroke-linejoin="round"
  />{/if}
