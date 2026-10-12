import type { Stimulus } from '../domain/types';

export function StimulusSvg({ stimulus, size = 120, label }: { stimulus: Stimulus; size?: number; label: string }) {
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      {stimulus.polygons.map((polygon, index) => (
        <polygon key={index} points={polygon.map(([x, y]) => `${x},${y}`).join(' ')} fill="currentColor" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
