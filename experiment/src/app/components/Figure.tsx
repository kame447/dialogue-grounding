import type { Point } from '../../ai/protocol';
import { bounds, pathData, transformPolygons } from '../../stimuli/scene';

/** One silhouette, optionally in the orientation it has in the scene; scales to its container. */
export function FigureArt({ polygons, rotation = 0, label }: { polygons: Point[][]; rotation?: number; label?: string }) {
  const shape = transformPolygons(polygons, { x: 0, y: 0, rotation, scale: 1 });
  const b = bounds(shape);
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const pad = size * 0.04;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return (
    <div className="figure-art">
      <svg role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} viewBox={`${cx - size / 2 - pad} ${cy - size / 2 - pad} ${size + pad * 2} ${size + pad * 2}`} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        {/* One path for all pieces: adjacent tans are filled together, so no hairline seams appear between them. */}
        <path d={pathData(shape)} fill="currentColor" stroke="currentColor" strokeWidth={size * 0.004} strokeLinejoin="round" />
      </svg>
    </div>
  );
}
