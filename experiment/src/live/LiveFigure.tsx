import type { Point } from './protocol';

export function LiveFigure({ polygons, label, size }: { polygons: Point[][]; label: string; size?: number }) {
  return <svg role="img" aria-label={label} width={size ?? 120} height={size ?? 120} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">{polygons.map((poly, i) => <polygon key={i} points={poly.map(([x, y]) => `${x},${y}`).join(' ')} fill="currentColor" />)}</svg>;
}
