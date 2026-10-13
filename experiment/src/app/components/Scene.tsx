import type { Figure } from '../../ai/protocol';
import { SCENE, pathData, worldPolygons } from '../../stimuli/scene';

/**
 * This seat's six silhouettes, scattered at the server-given positions and orientations
 * (src/stimuli/scene.ts). Figures carry no number, name or visible frame; the participant refers
 * to them by shape, position and orientation. Clicking a figure only acts locally (zoom / naming)
 * and is never sent to the AI.
 */
export function Scene(props: {
  figures: Figure[];
  /** Accessible name of each figure button (must not number the figures). */
  figureLabel?: (figure: Figure) => string;
  onPick?: (figure: Figure) => void;
  /** Participant's own names, drawn on the silhouettes (naming / confirmation / results). */
  names?: Record<string, string>;
  invalid?: ReadonlySet<string>;
  /** Show an empty marker on figures without a name. */
  markEmpty?: boolean;
  className?: string;
}) {
  const { figures, onPick } = props;
  return (
    <div className={`scene-area ${props.className ?? ''}`}>
      <div className="scene">
        <svg viewBox={`0 0 ${SCENE.width} ${SCENE.height}`} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden={onPick ? undefined : true}>
          {figures.map((figure) => {
            const d = pathData(worldPolygons(figure));
            const body = (
              <>
                <circle cx={figure.placement.x} cy={figure.placement.y} r={12} className="fig-hit" />
                <path d={d} className="fig-hit" />
                <path d={d} className="fig-shape" />
              </>
            );
            if (!onPick) return <g key={figure.slot}>{body}</g>;
            return (
              <g
                key={figure.slot}
                className="fig"
                role="button"
                tabIndex={0}
                aria-label={props.figureLabel?.(figure) ?? '図形を拡大'}
                onClick={() => onPick(figure)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(figure); } }}
              >
                {body}
              </g>
            );
          })}
        </svg>
        {props.names && figures.map((figure) => {
          const name = props.names?.[figure.slot]?.trim() ?? '';
          if (!name && !props.markEmpty) return null;
          return (
            <span
              key={figure.slot}
              aria-hidden="true"
              className={`name-pill ${name ? '' : 'name-pill-empty'} ${props.invalid?.has(figure.slot) ? 'name-pill-error' : ''}`}
              style={{ left: `${(figure.placement.x / SCENE.width) * 100}%`, top: `${(figure.placement.y / SCENE.height) * 100}%` }}
            >
              {name || '名前'}
            </span>
          );
        })}
      </div>
    </div>
  );
}
