/**
 * Axis-less sparkline — a visual cue, not a reading instrument (the Token
 * burn chart is the instrument). Inline SVG, normalized to its own max, flat
 * baseline when the series is silent.
 */
export function Sparkline({
  points,
  stroke,
  title,
}: {
  points: number[];
  stroke: string;
  title?: string;
}) {
  const W = 100;
  const H = 24;
  const PAD = 2;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const path = points
    .map((v, i) => {
      const x = PAD + i * step;
      const y = H - PAD - (v / max) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join("");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-6 w-full"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path
        d={`${path}L${W - PAD},${H - PAD}L${PAD},${H - PAD}Z`}
        fill={stroke}
        opacity={0.08}
        stroke="none"
      />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
