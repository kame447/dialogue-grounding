import { projectOwnRotationMemory } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/stimuli/rotation-memory.ts';
import { rotationMemoryLayer } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/decision/rotation-memory-guidance.ts';
import { generationGuardCodes } from '/Users/Shogo/.agentstack/worktrees/HappySomerville/dialogue-model/runtime/v2/generation-guard.ts';
for (const [k, r] of [['F1', 270], ['F6', 0], ['F9', 90], ['F15', 270]] as const) {
  const own = projectOwnRotationMemory({ figureKey: k, rotation: r })!;
  console.log(`== ${k}@${r}`, 'wholeAnywhere', own.wholeAnywhere);
  console.log(JSON.stringify(rotationMemoryLayer(own, 'nouns')));
  console.log('regions', JSON.stringify(own.regions.map(x => `${x.id} ${x.at} ${x.shapeName}${x.tip ? ' 頂点' + x.tip : ''}`)));
}
const f1 = projectOwnRotationMemory({ figureKey: 'F1', rotation: 270 })!;
console.log('F1 turned 270 roles', JSON.stringify(f1.turned[2].whole));
const exemplars: [string, string][] = [
  ['a 現在向きに見立てあり', 'カモが水に浮かんでいるように見えます。そちらはどうですか？'],
  ['c 否定の後・別方向', 'そうですか。見る角度によっては、ティーポットにも見えるかもしれません。'],
  ['e 相手の説明から別方向に気づく', 'ペンギンですか。こちらの画面では横になっていますが、向きを変えて見ると、短い三角がくちばし、全体がペンギンに見えます。'],
  ['f 全方向で全体なし（部分だけ）', '全体は何とも言いにくいのですが、小さい三角は耳か、くちばしのように見えます。'],
  ['b 現在向きに見立てなし', '今の向きだと何かには見えにくいのですが、向きを変えて見ると鳥のようにも見えます。'],
];
for (const mechanical of [true, false]) for (const [label, text] of exemplars) {
  const codes = generationGuardCodes(text, { action: 'accept', candidateName: null, v3: true, holistic: true, adaptive: true, factored: true, ai: true, mechanicalOnly: mechanical,
    publicTexts: ['一つ目は何かに見えますか？', text], humanTexts: ['一つ目は何かに見えますか？'], recentHumanTexts: ['一つ目は何かに見えますか？'], dialoguePolicy: 'holistic_v5', generationRetryVersion: 'jev_generation_retry_v24' } as never);
  console.log(mechanical ? 'mechanical' : 'full', label, JSON.stringify(codes), /P\d|[0-9]+度/u.test(text) ? 'ID/角度あり' : 'ID/角度なし');
}
