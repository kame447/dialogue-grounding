import { useRef, useState } from 'react';
import type { BlockSurvey, ComparisonSurvey } from '../domain/types';

/**
 * Prototype questionnaire with the project's OWN wording. It is not NASA-TLX,
 * not an official translation of the Paas scale, and is subject to review.
 */

function Scale(props: {
  name: string;
  legend: string;
  description: string;
  points: number;
  low: string;
  high: string;
  value: number | null;
  optional?: boolean;
  invalid?: boolean;
  onChange: (v: number) => void;
}) {
  const descId = `${props.name}-desc`;
  return (
    <fieldset className="scale" aria-describedby={descId} aria-invalid={props.invalid || undefined}>
      <legend>
        {props.legend}
        {props.optional ? <span className="optional-tag">任意</span> : null}
      </legend>
      <p className="scale-desc" id={descId}>
        {props.description}（1＝{props.low}、{props.points}＝{props.high}）
      </p>
      <div className="scale-options" data-n={props.points} style={{ ['--n' as string]: props.points }}>
        {Array.from({ length: props.points }, (_, i) => i + 1).map((v) => (
          <label key={v} className="scale-option">
            <input type="radio" name={props.name} value={v} checked={props.value === v} onChange={() => props.onChange(v)} />
            <span>
              {v}
              <span className="visually-hidden">{v === 1 ? `（${props.low}）` : v === props.points ? `（${props.high}）` : ''}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="scale-anchors" aria-hidden="true">
        <span>{props.low}</span>
        <span>{props.high}</span>
      </div>
      {props.invalid ? <p className="field-error">この項目に回答してください。</p> : null}
    </fieldset>
  );
}

const emptySurvey: BlockSurvey = { effort: null, fluency: null, annoyance: null, naturalness: null, satisfaction: null, comment: '' };

export function BlockSurveyScreen(props: { round: 1 | 2; onSubmit: (s: BlockSurvey) => void }) {
  const [s, setS] = useState<BlockSurvey>(emptySurvey);
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const required = ['effort', 'fluency', 'annoyance'] as const;
  const missing = required.filter((k) => s[k] === null);
  const set = (k: keyof BlockSurvey) => (v: number) => setS((prev) => ({ ...prev, [k]: v }));

  return (
    <form
      className="narrow"
      aria-labelledby="survey-title"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (missing.length) {
          requestAnimationFrame(() => alertRef.current?.focus());
          return;
        }
        if (sent) return;
        setSent(true);
        props.onSubmit(s);
      }}
    >
      <div className="panel">
        <h1 id="survey-title">ラウンド {props.round} / 2 についての質問</h1>
        <p>名前は提出済みです。いま終えたラウンドの<strong>会話中</strong>のことを思い出して答えてください。正解かどうかは、まだ表示されません。</p>
        {tried && missing.length ? (
          <div className="alert" role="alert" tabIndex={-1} ref={alertRef}>
            未回答の必須項目が{missing.length}つあります。
          </div>
        ) : null}
      </div>
      <div className="panel">
        <Scale
          name="effort"
          legend="1. 会話中に注いだ精神的な努力"
          description="この会話を進めるために、あなたはどのくらい頭を使いましたか"
          points={9}
          low="ごくわずか"
          high="非常に多く"
          value={s.effort}
          invalid={tried && s.effort === null}
          onChange={set('effort')}
        />
        <Scale
          name="fluency"
          legend="2. 対話の進めやすさ"
          description="この会話はどのくらい進めやすかったですか"
          points={7}
          low="とても進めにくい"
          high="とても進めやすい"
          value={s.fluency}
          invalid={tried && s.fluency === null}
          onChange={set('fluency')}
        />
        <Scale
          name="annoyance"
          legend="3. 煩わしさ"
          description="この会話にどのくらい煩わしさを感じましたか"
          points={7}
          low="まったく感じない"
          high="とても感じた"
          value={s.annoyance}
          invalid={tried && s.annoyance === null}
          onChange={set('annoyance')}
        />
        <Scale name="naturalness" legend="4. 相手の応答の自然さ" description="相手の応答はどのくらい自然でしたか" points={7} low="まったく自然でない" high="とても自然" value={s.naturalness} optional onChange={set('naturalness')} />
        <Scale name="satisfaction" legend="5. 会話への満足度" description="この会話にどのくらい満足していますか" points={7} low="まったく満足していない" high="とても満足している" value={s.satisfaction} optional onChange={set('satisfaction')} />
        <label htmlFor="survey-comment" style={{ fontWeight: 600, display: 'block' }}>
          6. 自由記述 <span className="optional-tag">任意</span>
        </label>
        <p className="scale-desc">気づいたこと、やりにくかった点などがあれば書いてください。</p>
        <textarea id="survey-comment" rows={3} maxLength={1000} value={s.comment} onChange={(e) => setS((prev) => ({ ...prev, comment: e.target.value }))} />
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={sent}>
            回答を送信
          </button>
        </div>
      </div>
    </form>
  );
}

type Choice = 'round1' | 'round2' | 'same';

function Choice3(props: { name: string; legend: string; value: Choice | null; invalid: boolean; onChange: (v: Choice) => void }) {
  const opts: { v: Choice; label: string }[] = [
    { v: 'round1', label: 'ラウンド1' },
    { v: 'round2', label: 'ラウンド2' },
    { v: 'same', label: '同じくらい' },
  ];
  return (
    <fieldset className="scale" aria-invalid={props.invalid || undefined}>
      <legend>{props.legend}</legend>
      <div className="choice-list">
        {opts.map((o) => (
          <label key={o.v}>
            <input type="radio" name={props.name} value={o.v} checked={props.value === o.v} onChange={() => props.onChange(o.v)} />
            {o.label}
          </label>
        ))}
      </div>
      {props.invalid ? <p className="field-error">この項目に回答してください。</p> : null}
    </fieldset>
  );
}

export function ComparisonScreen(props: { onSubmit: (c: ComparisonSurvey) => void }) {
  const [c, setC] = useState<ComparisonSurvey>({ lessEffort: null, easier: null, lessAnnoying: null, comment: '' });
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(false);
  const missing = (['lessEffort', 'easier', 'lessAnnoying'] as const).filter((k) => c[k] === null);
  return (
    <form
      className="narrow"
      aria-labelledby="cmp-title"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (missing.length || sent) return;
        setSent(true);
        props.onSubmit(c);
      }}
    >
      <div className="panel">
        <h1 id="cmp-title">2つのラウンドの比較</h1>
        <p>ラウンド1とラウンド2の会話を比べて答えてください。</p>
        {tried && missing.length ? (
          <div className="alert" role="alert">
            未回答の項目が{missing.length}つあります。
          </div>
        ) : null}
      </div>
      <div className="panel">
        <Choice3 name="lessEffort" legend="1. 精神的な努力が少なくて済んだのはどちらですか" value={c.lessEffort} invalid={tried && c.lessEffort === null} onChange={(v) => setC({ ...c, lessEffort: v })} />
        <Choice3 name="easier" legend="2. 対話を進めやすかったのはどちらですか" value={c.easier} invalid={tried && c.easier === null} onChange={(v) => setC({ ...c, easier: v })} />
        <Choice3 name="lessAnnoying" legend="3. 煩わしさが少なかったのはどちらですか" value={c.lessAnnoying} invalid={tried && c.lessAnnoying === null} onChange={(v) => setC({ ...c, lessAnnoying: v })} />
        <label htmlFor="cmp-comment" style={{ fontWeight: 600, display: 'block' }}>
          4. 違いを感じた点 <span className="optional-tag">任意</span>
        </label>
        <textarea id="cmp-comment" rows={3} maxLength={1000} value={c.comment} onChange={(e) => setC({ ...c, comment: e.target.value })} />
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={sent}>
            回答を送信
          </button>
        </div>
      </div>
    </form>
  );
}
