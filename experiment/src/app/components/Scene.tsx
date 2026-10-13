import type { Figure, NameAnswer } from '../../ai/protocol';
import { SCENE, pathData, worldPolygons } from '../../stimuli/scene';

export interface SceneLabel { text: string; tone?: 'muted' | 'error' }

/** Label for a post-conversation answer: a name, "未合意" (null) or, when not answered yet, "未回答". */
export function answerLabel(answer: NameAnswer | undefined, error = false): SceneLabel {
  if (answer === undefined) return { text: '未回答', tone: 'muted' };
  if (answer === null) return { text: '未合意', tone: 'muted' };
  return { text: answer, tone: error ? 'error' : undefined };
}
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
  /** Participant's own answers, drawn on the silhouettes (answer form / confirmation / results). */
  labels?: Record<string, SceneLabel>;
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
        {props.labels && figures.map((figure) => {
          const label = props.labels?.[figure.slot];
          if (!label) return null;
          return (
            <span
              key={figure.slot}
              aria-hidden="true"
              className={`name-pill ${label.tone === 'muted' ? 'name-pill-empty' : ''} ${label.tone === 'error' ? 'name-pill-error' : ''}`}
              style={{ left: `${(figure.placement.x / SCENE.width) * 100}%`, top: `${(figure.placement.y / SCENE.height) * 100}%` }}
            >
              {label.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
