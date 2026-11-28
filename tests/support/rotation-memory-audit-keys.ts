// D 監査（AquaGauss）: 旧受付の観察キャッシュ鍵を計算する。回転別メモの追加で、旧 pin・旧 #262 の受付の鍵が変わらないことの確認に使う。
// 期待値 tests/fixtures/rotation-memory-audit/old-path-keys-75c66cc.json は基点 75c66cc から
// `node tests/support/rotation-memory-audit-keys.ts <75c66cc の木>` で一度だけ生成した。後の版から作り直さない（作り直すと検出力が失われる）。
// 木は AUDIT_REPO_ROOT で切り替えられる（他の担当の worktree を読み取りだけで検査する。書き込みはしない）。
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = unknown;
type Selection = unknown;

/** 検査する木の根。AUDIT_REPO_ROOT が無ければこのファイルのあるリポジトリ。 */
export const auditRoot = (): string => {
  const given = process.env.AUDIT_REPO_ROOT;
  const root = given && given.length > 0 ? given : fileURLToPath(new URL('../../', import.meta.url));
  return root.endsWith('/') ? root : root + '/';
};

export const ROTATION_MODES_UNDER_AUDIT = ['relative_pm90', 'relative_0', 'relative_90_180_270'] as const;
export const SELECTIONS_UNDER_AUDIT: Record<string, Selection> = {
  legacy6: undefined,
  pilot4: { mode: 'preset', setId: 'pilot-four-v1' },
  custom3: { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] },
};
export const SEEDS_UNDER_AUDIT = [0, 1, 7, 104729];

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 3 回転方式 × 3 図形構成 × 4 seed の旧受付の鍵（Worker の初回観察鍵 3 種とローカルのキャッシュ鍵）。ネットワークは使わない。 */
export async function computeOldPathKeys(root: string = auditRoot()): Promise<Record<string, Record<string, Json>>> {
  const load = (path: string): Promise<any> => import(pathToFileURL(root + path).href);
  const { createTrialV2, modelView } = await load('dialogue-model/runtime/stimuli/scatter-v2.mjs');
  const { workerTerraInitialKey } = await load('dialogue-model/runtime/observation/worker-terra-observer.ts');
  const { createObservationCacheKey } = await load('dialogue-model/runtime/observation/cache.ts');
  const { validateParticipantModelPin } = await load('dialogue-model/runtime/v2/participant-model-pin.ts');
  const generations = await load('dialogue-model/runtime/observation/initial-observation-generation.ts');
  const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v3', terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261014' });
  const out: Record<string, Record<string, Json>> = {};
  for (const mode of ROTATION_MODES_UNDER_AUDIT) for (const [name, figureSelection] of Object.entries(SELECTIONS_UNDER_AUDIT)) for (const seed of SEEDS_UNDER_AUDIT) {
    const trial = createTrialV2({ seed, rotationMode: mode, ...(figureSelection === undefined ? {} : { figureSelection }) });
    const view = modelView(trial);
    const own = { ownImage: { mimeType: view.mimeType, base64: view.png.toString('base64') }, ownAnchors: view.anchors };
    out[`${mode}|${name}|${seed}`] = {
      workerKeyV2: await workerTerraInitialKey(pin, own, generations.INITIAL_OBSERVATION_STRUCTURED_V2),
      workerKeyV1: await workerTerraInitialKey(pin, own, generations.INITIAL_OBSERVATION_STRUCTURED_V1),
      workerKeyNone: await workerTerraInitialKey(pin, own, undefined),
      localKey: createObservationCacheKey(own, { modelId: 'synthetic-model' }),
    };
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? (process.argv[2].endsWith('/') ? process.argv[2] : process.argv[2] + '/') : auditRoot();
  const keys = await computeOldPathKeys(root);
  process.stdout.write(JSON.stringify({ baseCommit: process.argv[3] ?? null, keys }, null, 1) + '\n');
}
