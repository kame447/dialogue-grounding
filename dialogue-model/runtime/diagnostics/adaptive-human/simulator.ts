/** Diagnostic participant only. No task state, assignment or evaluator input. */
export type Persona = Readonly<{style: 'brief'; cooperation: 'cooperative'; initialUncertainty: number; focus: 'outline' | 'parts'}>;
export type PublicTurn = Readonly<{speaker: 'human' | 'ai'; text: string}>;
export type HumanInput = Readonly<{persona: Persona; history: readonly PublicTurn[];
  boardImage?: Readonly<{mimeType: 'image/png' | 'image/jpeg'; base64: string}>}>;
/** Also reject structurally wider variables at typed call sites, not just object literals. */
export type ExactInput<T extends HumanInput> = T & Record<Exclude<keyof T, keyof HumanInput>, never> & {
  persona: T['persona'] & Record<Exclude<keyof T['persona'], keyof Persona>, never>;
  history: readonly (T['history'][number] & Record<Exclude<keyof T['history'][number], keyof PublicTurn>, never>)[];
} & (T extends {boardImage: infer B} ? {boardImage: B & Record<Exclude<keyof B, 'mimeType' | 'base64'>, never>} : unknown);
export type Belief = {referent: string; name: string | null; understanding: number};
export type HumanOutput = {utterance: string; done: boolean; private: {beliefs: Belief[]; uncertainty: number;
  question: string | null; understandingChange: 'increased' | 'unchanged' | 'decreased'}};

const fail = (): never => { throw new Error('invalid_adaptive_human_data'); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key) ||
      !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) return fail();
  return value as Record<string, any>;
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function list(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length || !Object.hasOwn(fields[key], 'value'))) ||
      Object.keys(fields).length !== value.length + 1) return fail();
  return value;
}

/** A separate seed creates initial traits; the simulator never accepts an assignment seed. */
export function createPersona(seed: number): Persona {
  if (!Number.isSafeInteger(seed)) return fail();
  let n = seed >>> 0; n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n ^= n >>> 16;
  return Object.freeze({style: 'brief', cooperation: 'cooperative', initialUncertainty: 0.4 + (n >>> 0) % 4 / 10,
    focus: n & 1 ? 'outline' : 'parts'});
}

export function validateInput(value: unknown): HumanInput {
  const v = object(value, ['persona', 'history'], ['boardImage']);
  const p = object(v.persona, ['style', 'cooperation', 'initialUncertainty', 'focus']);
  if (p.style !== 'brief' || p.cooperation !== 'cooperative' || !unit(p.initialUncertainty) || !['outline', 'parts'].includes(p.focus)) return fail();
  for (const turn of list(v.history, 1000)) {
    const t = object(turn, ['speaker', 'text']);
    if (!['human', 'ai'].includes(t.speaker) || !text(t.text, 16000)) return fail();
  }
  if (Object.hasOwn(v, 'boardImage')) {
    const image = object(v.boardImage, ['mimeType', 'base64']);
    if (!['image/png', 'image/jpeg'].includes(image.mimeType) || !text(image.base64, 20000000) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.base64)) return fail();
  }
  return structuredClone(v) as HumanInput;
}

export function validateOutput(value: unknown): HumanOutput {
  const v = object(value, ['utterance', 'done', 'private']);
  const p = object(v.private, ['beliefs', 'uncertainty', 'question', 'understandingChange']);
  if (!text(v.utterance, 2000) || typeof v.done !== 'boolean' || !unit(p.uncertainty) ||
      p.question !== null && !text(p.question, 2000) || !['increased', 'unchanged', 'decreased'].includes(p.understandingChange) ||
      !Array.isArray(p.beliefs)) return fail();
  for (const belief of list(p.beliefs, 100)) {
    const b = object(belief, ['referent', 'name', 'understanding']);
    if (!text(b.referent, 500) || b.name !== null && !text(b.name, 100) || !unit(b.understanding)) return fail();
  }
  return structuredClone(v) as HumanOutput;
}

/** Literal public-language baseline, not a vision model or calibrated human measure. */
export function mockHuman<T extends HumanInput>(input: ExactInput<T>): HumanOutput {
  const {history, persona} = validateInput(input);
  const ai = history.filter(t => t.speaker === 'ai').at(-1)?.text ?? '';
  const previous = history.filter(t => t.speaker === 'human').map(t => t.text).join('\n');
  const name = ai.match(/[「『]([^」』]{1,40})[」』]/u)?.[1] ?? null;
  const feature = ai.match(/(?:細い部分|三角の部分|長い部分|尖った部分|丸い部分|二つの部分|四角い部分)/u)?.[0] ?? null;
  const referent = ai.match(/(?:左上|右上|左下|右下|真ん中|中央)の?(?:図形|形)?/u)?.[0] ?? '今話している図形';
  let utterance: string, question: string | null = null, understanding = 1 - persona.initialUncertainty;
  let change: HumanOutput['private']['understandingChange'] = 'unchanged';
  if (!ai) {
    utterance = persona.focus === 'parts' ? '形の特徴を一つずつ確かめながら、名前を決めたいです。' : 'まず、どの形から話しましょうか？';
  } else if (name && feature && (previous.includes(feature) || /という名前|と呼|にし|どうでしょう/u.test(ai))) {
    utterance = `その${feature}を目印に「${name}」と呼ぶのですね。分かりました。`;
    understanding = 0.8; change = 'increased';
  } else if (/[？?]|教えて|ありますか|見えますか/u.test(ai) && feature) {
    // Repeat one publicly mentioned feature; never fabricate a bitmap observation.
    utterance = `気になっているのは${feature}です。その部分を目印にすればよいですか？`;
    question = `その${feature}を目印にすればよいですか？`;
  } else if (name && /分かりました|呼ぶのですね/u.test(previous) && previous.includes(name)) {
    utterance = `はい、「${name}」で覚えています。`; understanding = 0.8;
  } else {
    question = name ? `「${name}」は、どんな特徴の形ですか？` : 'どの部分を目印にすればよいですか？';
    utterance = question;
  }
  return validateOutput({utterance, done: false, private: {beliefs: ai ? [{referent, name, understanding}] : [],
    uncertainty: 1 - understanding, question, understandingChange: change}});
}

export const HUMAN_SYSTEM = `あなたは共同命名課題の人間役です。協力的ですが理解に不確かさがあります。
見える盤面と公開対話だけを使い、短い自然な日本語で答えてください。質問には分かる特徴を一つ答え、
分からなければ質問や確認を試み、理解できた名前は自然に確認・同意してください。
混乱や拒否、保留して次へ進むことを無理に演じる必要はありません。全体が終わったと自分で判断したら done=true。
次の閉じた JSON だけを返してください（余分な key 不可）:
{"utterance":"公開発話","done":false,"private":{"beliefs":[{"referent":"自分の画面上の位置や公開の特徴","name":null,"understanding":0.3}],"uncertainty":0.7,"question":null,"understandingChange":"unchanged"}}
understanding/uncertainty は0〜1の主観的な仮値で正答確率ではありません。understandingChange は increased/unchanged/decreased。
private は評価用です。公開発話に内部記録やJSONを含めません。画像がなければ見えたように言わないでください。`;

/** Inject a purpose-only runtime/client.mjs client, so the parent's fetch guard sees every POST. */
export function createLiveHuman(client: {complete(messages: any[]): Promise<{text: string}>}) {
  return async <T extends HumanInput>(input: ExactInput<T>): Promise<HumanOutput> => {
    const safe = validateInput(input);
    const content: any[] = [{type: 'text', text: JSON.stringify({persona: safe.persona, history: safe.history})}];
    if (safe.boardImage) content.push({type: 'image_url', image_url: {url: `data:${safe.boardImage.mimeType};base64,${safe.boardImage.base64}`}});
    const response = await client.complete([{role: 'system', content: HUMAN_SYSTEM}, {role: 'user', content}]);
    try { return validateOutput(JSON.parse(response.text)); } catch { throw new Error('invalid_adaptive_human_response'); }
  };
}
