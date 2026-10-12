import { useState } from 'react';

export function WelcomeScreen(props: { onStart: () => void; resumable: boolean }) {
  return (
    <section className="panel narrow" aria-labelledby="welcome-title">
      <h1 id="welcome-title">図形の共同命名タスク（デモ）</h1>
      <p>
        この画面は研究用インターフェースの<strong>試作品（DEMO）</strong>です。対話相手はAIではなく、決まった規則で返答する簡易モックです。
      </p>
      <ul className="plain">
        <li>あなたと相手は、同じ6個の図形をそれぞれ<strong>別の並び順</strong>で見ています。相手の画面は見えません。</li>
        <li>チャットで相談しながら、6個の図形それぞれに、互いに区別できる名前をつけてください。</li>
        <li>ラウンドは2回あり、各ラウンドの後に短い質問に答えていただきます。</li>
      </ul>
      <p className="callout">
        氏名・メールアドレスなどの個人情報は入力しないでください。入力内容はこのブラウザのタブ内（sessionStorage）だけに保存され、外部へは送信されません。
      </p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={props.onStart}>
          {props.resumable ? 'デモを続ける' : 'デモをはじめる'}
        </button>
      </div>
    </section>
  );
}

export function ConsentScreen(props: { onAgree: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <section className="panel narrow" aria-labelledby="consent-title">
      <h1 id="consent-title">参加にあたっての確認（仮）</h1>
      <p className="callout">これは本番の正式な説明・同意手続きではありません。プロトタイプ確認用の仮の画面です。</p>
      <ul className="plain">
        <li>参加は任意で、いつでも中断できます（タブを閉じると入力内容は消えます）。</li>
        <li>途中で前の画面に戻って回答を変えることはできません。</li>
        <li>会話の内容・入力時刻・質問への回答が、このタブ内に記録されます。</li>
        <li>本番では、研究倫理審査で承認された説明文書と同意手続きに置き換えます。</li>
      </ul>
      <label className="check-row">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>上記を読み、デモとして進めることに同意します</span>
      </label>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!checked} onClick={props.onAgree}>
          同意して進む
        </button>
      </div>
    </section>
  );
}

export function InstructionsScreen(props: { onBegin: () => void }) {
  return (
    <section className="panel narrow" aria-labelledby="inst-title">
      <h1 id="inst-title">課題の説明</h1>
      <ol className="plain">
        <li>画面に6個の図形が表示されます。相手にも同じ6個が、<strong>別の並び順</strong>で表示されています。</li>
        <li>図形の番号（図形1〜6）はあなたの画面の中だけのものです。番号を伝えても相手には通じません。形の特徴や見立てで伝え合ってください。</li>
        <li>チャットで相談し、6個それぞれに<strong>互いに区別できる名前</strong>をつけてください。</li>
        <li>話し合いが済んだら「会話を終えて名前の入力へ」を押します。その後、あなたと相手が<strong>それぞれ独立に</strong>6個の名前を提出します。</li>
        <li>6個の名前はすべて異なるものにしてください（同じ名前の重複は不適格になります）。確定した名前は変更できません。</li>
        <li>名前の提出後に、そのラウンドについての短い質問があります。</li>
      </ol>
      <p className="muted small">各図形は「拡大」で大きく表示できます。メモ欄はあなただけのもので、相手には送られません。</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={props.onBegin}>
          ラウンド1を始める
        </button>
      </div>
    </section>
  );
}

export function InterblockScreen(props: { onBegin: () => void }) {
  return (
    <section className="panel narrow" aria-labelledby="ib-title">
      <h1 id="ib-title">ラウンド1が終わりました</h1>
      <p>次のラウンド2では、<strong>別の6個の図形</strong>を使います。進め方はラウンド1と同じです。</p>
      <p className="muted small">準備ができたら始めてください。</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={props.onBegin}>
          ラウンド2を始める
        </button>
      </div>
    </section>
  );
}

export function DoneScreen(props: { onRestart: () => void }) {
  return (
    <section className="panel narrow" aria-labelledby="done-title">
      <h1 id="done-title">ご協力ありがとうございました</h1>
      <p>デモはこれで終了です。記録はこのタブ内にのみ保存されています。</p>
      <div className="actions">
        <button type="button" className="btn" onClick={props.onRestart}>
          記録を消去して最初に戻る
        </button>
      </div>
    </section>
  );
}
