// D 監査（AquaGauss）: 承認済み受付（plan を含む記録）の旧版のバイトを計算する。回転別メモの pin の追加で、旧受付の計画・記録が変わらないことの確認に使う。
// 期待値 tests/fixtures/rotation-memory-audit/approved-receptions-75c66cc.json は基点 75c66cc から
// `node tests/support/rotation-memory-audit-plans.ts <75c66cc の木> 75c66cc` で一度だけ生成した。後の版から作り直さない。
// 木は AUDIT_REPO_ROOT で切り替える（読み取りだけ）。ネットワークは使わない。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditRoot } from './rotation-memory-audit-keys.ts';

const PROTOCOL_ID = '20000000-0000-4000-8000-0000000000a1';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const ORDERS = [['repair-first', 'bypass-enabled'], ['bypass-enabled', 'repair-first']];
const VALID_PREPARED = { schemaVersion: 'prepared_observations_v1', bundleId: '10000000-0000-4000-8000-0000000000b1', preparedAt: '2026-01-01T00:00:00.000Z',
  trials: [0, 1].map(index => ({ index, cacheKey: 'terra_initial_observation_v1:' + String(index + 1).repeat(64), memoSha256: String(index + 3).repeat(64) })) };

export type AuditCase = { id: string; protocol: Record<string, unknown>; participant: Record<string, unknown>; production: boolean; order: number };

/** 旧受付の種類: プロトコルの版（v1/v2/v3、回転方式、図形構成）× 参加者の設定（なし・旧・production・v24・#262 の準備済み）× 受付の順。 */
export async function buildAuditCases(root: string = auditRoot()): Promise<AuditCase[]> {
  const load = (path: string): Promise<any> => import(pathToFileURL(root + path).href);
  const { validateParticipantModelPin } = await load('dialogue-model/runtime/v2/participant-model-pin.ts');
  const { INITIAL_OBSERVATION_STRUCTURED_V2 } = await load('dialogue-model/runtime/observation/initial-observation-generation.ts');
  const pin = validateParticipantModelPin({ schemaVersion: 'participant_model_pin_v3', terraModelId: 'gpt-6.1-terra-2026-11-01', jevModelId: 'typesafe/jev-1.14-20261014' });
  const production = { participantModelPin: pin, participantRuntimeProfile: 'participant_production_usage_v1', participantDialogueProfile: 'participant_dialogue_v23_prompt_consolidation',
    memoryPruneVersion: 'claim_prune_v3', openingMode: 'scripted_v1', initialObservationGeneration: INITIAL_OBSERVATION_STRUCTURED_V2 };
  const participants: Record<string, { settings: Record<string, unknown>; production: boolean }> = {
    none: { settings: {}, production: false },
    prune: { settings: { memoryPruneVersion: 'claim_prune_v3' }, production: false },
    production: { settings: production, production: true },
    v24on: { settings: { ...production, participantDialogueProfile: 'participant_dialogue_v24_precheck_reduction', postGenerationCheck: 'on' }, production: true },
    prepared262: { settings: { ...production, preparedObservations: VALID_PREPARED }, production: true },
  };
  const base = { protocolId: PROTOCOL_ID, revision: 1, allowedOrders: ORDERS, seedPolicy: 'shared', betweenTrials: 'none', receptionNumberFormat: 'daily_seq3' };
  const protocols: Record<string, { value: Record<string, unknown>; participants: string[] }> = {
    v1: { value: { schemaVersion: 'reception_protocol_v1', ...base, referenceMemory: true }, participants: ['none', 'prune'] },
    'v2-pm90': { value: { schemaVersion: 'reception_protocol_v2', ...base, referenceMemory: true, rotationMode: 'relative_pm90' }, participants: Object.keys(participants) },
    'v2-rel0-nomemory': { value: { schemaVersion: 'reception_protocol_v2', ...base, referenceMemory: false, rotationMode: 'relative_0' }, participants: ['none', 'production'] },
    'v3-pm90-pilot4': { value: { schemaVersion: 'reception_protocol_v3', ...base, referenceMemory: true, rotationMode: 'relative_pm90', figureSelection: { mode: 'preset', setId: 'pilot-four-v1' }, figureSetPolicy: 'shared' }, participants: Object.keys(participants) },
    'v3-90180270-custom3': { value: { schemaVersion: 'reception_protocol_v3', ...base, betweenTrials: 'questionnaire_required', referenceMemory: true, rotationMode: 'relative_90_180_270', figureSelection: { mode: 'custom', figureIds: ['F2', 'F17', 'F30'] }, figureSetPolicy: 'shared' }, participants: Object.keys(participants) },
    'v3-rel0-seeded3': { value: { schemaVersion: 'reception_protocol_v3', ...base, referenceMemory: true, rotationMode: 'relative_0', figureSelection: { mode: 'seeded_random', selectionSeed: 11, figureCount: 3 }, figureSetPolicy: 'shared' }, participants: ['none', 'production', 'v24on'] },
    'v3-per-trial-seeded6': { value: { schemaVersion: 'reception_protocol_v3', ...base, seedPolicy: 'per_trial', referenceMemory: true, rotationMode: 'relative_pm90', figureSelection: { mode: 'seeded_random', selectionSeed: null, figureCount: 6 }, figureSetPolicy: 'per_trial' }, participants: ['production'] },
  };
  const cases: AuditCase[] = [];
  for (const [protocolName, { value, participants: names }] of Object.entries(protocols)) for (const name of names) for (const order of [0, 1])
    cases.push({ id: `${protocolName}|${name}|order${order}`, protocol: value, participant: participants[name].settings, production: participants[name].production, order });
  return cases;
}

/** 各ケースの承認済み受付（記録全体）を JSON 文字列で返す。失敗はメッセージを値にする（拒否の変化も検出できる）。 */
export async function approveAll(cases: AuditCase[], root: string = auditRoot()): Promise<Record<string, string>> {
  const reception: any = await import(pathToFileURL(root + 'dialogue-model/runtime/v2/reception.ts').href);
  const out: Record<string, string> = {};
  for (const c of cases) {
    try {
      let seed = 1000;
      const canonical = c.protocol.schemaVersion === 'reception_protocol_v3' ? reception.canonicalReceptionProtocolV3(c.protocol)
        : c.protocol.schemaVersion === 'reception_protocol_v2' ? reception.canonicalReceptionProtocolV2(c.protocol) : reception.canonicalReceptionProtocol(c.protocol);
      const pending = reception.createReception({ receptionId: '00000000-0000-4000-8000-000000000001', objectId: '0'.repeat(64), createdAt: CREATED_AT, number: null });
      const approved = await reception.approveReception(pending, { ...c.participant, expectedRevision: 0, order: c.order, protocol: JSON.parse(canonical),
        expected: { protocolId: c.protocol.protocolId, revision: c.protocol.revision, sha256: reception.receptionProtocolSha256(canonical) },
        approvedAt: CREATED_AT, randomSeed: () => seed++ });
      out[c.id] = JSON.stringify(approved);
    } catch (error) { out[c.id] = 'error:' + (error instanceof Error ? error.message : String(error)); }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? process.argv[2].replace(/\/?$/, '/') : auditRoot();
  const cases = await buildAuditCases(root);
  process.stdout.write(JSON.stringify({ baseCommit: process.argv[3] ?? null, receptions: await approveAll(cases, root) }, null, 1) + '\n');
}
