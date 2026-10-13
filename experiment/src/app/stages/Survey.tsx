import { useState } from 'react';
import { LIMITS, type Survey } from '../../ai/protocol';
import type { RoomApi } from '../useRoom';

type Key = 'effort' | 'fluency' | 'annoyance';
const QUESTIONS: { key: Key; title: string; prompt: string; count: number; low: string; high: string }[] = [
  { key: 'effort', title: '精神的努力', prompt: 'この課題に、どれくらい精神的な努力が必要でしたか。', count: 9, low: '非常に少ない', high: '非常に多い' },
  { key: 'fluency', title: '円滑さ', prompt: 'AIとのやりとりは、どれくらい円滑に進みましたか。', count: 7, low: 'まったく円滑でない', high: '非常に円滑' },
  { key: 'annoyance', title: '煩わしさ', prompt: 'AIとのやりとりを、どれくらい煩わしく感じましたか。', count: 7, low: 'まったく感じない', high: '非常に感じる' },
];

export function SurveyStage({ room }: { room: RoomApi }) {
  const [values, setValues] = useState<Record<Key, number>>({ effort: 0, fluency: 0, annoyance: 0 });
  const [comment, setComment] = useState('');
  const [attempted, setAttempted] = useState(false);
  const missing = QUESTIONS.filter((q) => !values[q.key]);
  const submit = () => {
    setAttempted(true);
    if (missing.length) {
      document.getElementById(`q-${missing[0].key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    room.submitSurvey({ ...values, comment } satisfies Survey);
  };
  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>やりとりについての質問</h1>
          <p>結果の前に、3つの質問に答えてください。回答はAIには渡されません。</p>
        </div>
      </div>
      {QUESTIONS.map((q) => (
        <section key={q.key} id={`q-${q.key}`} className={`question ${attempted && !values[q.key] ? 'question-missing' : ''}`}>
          <h2 id={`q-${q.key}-title`}>{q.title}</h2>
          <p id={`q-${q.key}-prompt`}>{q.prompt}</p>
          <div className="scale" role="radiogroup" aria-labelledby={`q-${q.key}-title`} aria-describedby={`q-${q.key}-prompt`} style={{ ['--n' as string]: q.count }}>
            {Array.from({ length: q.count }, (_, i) => i + 1).map((n) => (
              <label className="scale-opt" key={n}>
                <input type="radio" name={q.key} value={n} checked={values[q.key] === n} onChange={() => setValues((v) => ({ ...v, [q.key]: n }))} aria-label={String(n)} />
                <span aria-hidden="true">{n}</span>
              </label>
            ))}
          </div>
          <div className="scale-anchors" aria-hidden="true"><span>1 {q.low}</span><span>{q.count} {q.high}</span></div>
        </section>
      ))}
      <section className="question">
        <label htmlFor="survey-comment"><h2>感想（任意）</h2></label>
        <textarea id="survey-comment" className="field-input comment" maxLength={LIMITS.maxCommentChars} value={comment} onChange={(e) => setComment(e.target.value)} />
      </section>
      {attempted && missing.length > 0 && <p className="alert" role="alert">未回答の項目があります：{missing.map((q) => q.title).join('・')}</p>}
      <div className="after-actions">
        <p className="note">独自の暫定項目です（検証済みの尺度ではありません）。</p>
        <button className="btn btn-primary" onClick={submit} disabled={room.busy}>回答を送信</button>
      </div>
    </main>
  );
}
