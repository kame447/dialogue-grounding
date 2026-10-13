import type { Point } from '../../ai/protocol';

/** Silhouette in a 0..100 box; scales to its container. */
export function FigureArt({ polygons, label }: { polygons: Point[][]; label?: string }) {
  return (
    <div className="figure-art">
      <svg role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} viewBox="-2 -2 104 104" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        {/* One path for all pieces: adjacent tans are filled together, so no hairline seams appear between them. */}
        <path d={polygons.map((poly) => `M${poly.map(([x, y]) => `${x},${y}`).join('L')}Z`).join('')} fill="currentColor" stroke="currentColor" strokeWidth="0.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
