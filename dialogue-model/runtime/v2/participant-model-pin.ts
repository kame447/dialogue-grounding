// Private, researcher-owned runtime identity. Neither strategy nor participant
// input selects a model. Persist a detached copy at reception approval.
type ModelIds = Readonly<{
  terraModelId: string;
  lunaModelId: string;
  jevModelId: string;
}>;

export type LegacyParticipantModelPin = ModelIds & Readonly<{ schemaVersion: 'participant_model_pin_v1' }>;
export type GenerationParticipantModelPin = ModelIds & Readonly<{
  schemaVersion: 'participant_model_pin_v2'; generationModelId: string;
}>;
export type AllTerraParticipantModelPin = Pick<ModelIds, 'terraModelId' | 'jevModelId'> &
  Readonly<{ schemaVersion: 'participant_model_pin_v3' }>;
export type ParticipantModelPin = LegacyParticipantModelPin | GenerationParticipantModelPin | AllTerraParticipantModelPin;

const KEYS = ['schemaVersion', 'terraModelId', 'lunaModelId', 'jevModelId'];
const TERRA = /^gpt-6\.1-terra(?:-(?:\d{4}-\d{2}-\d{2}|\d{8}))?$/u;
const LUNA = /^gpt-6-luna(?:-(?:\d{4}-\d{2}-\d{2}|\d{8}))?$/u;
export function participantChatProvider(pin: ParticipantModelPin, phase: unknown): 'luna' | 'terra' {
  return pin.schemaVersion === 'participant_model_pin_v3' ||
    (pin.schemaVersion === 'participant_model_pin_v2' && (phase === 'generation' || phase === 'final_submission'))
    ? 'terra' : 'luna';
}
const JEV = /^typesafe\/jev-1\.14(?:-\d{8})?$/u;

export class ParticipantModelPinError extends Error {
  readonly code: 'invalid_model_pin' | 'model_mismatch';
  constructor(code: ParticipantModelPinError['code']) {
    super(code);
    this.name = 'ParticipantModelPinError';
    this.code = code;
  }
}

function invalid(): never {
  throw new ParticipantModelPinError('invalid_model_pin');
}

function record(value: unknown): object {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  return value as object;
}

function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return invalid();
  return descriptor.value;
}

export function validateParticipantModelPin<Version extends ParticipantModelPin['schemaVersion']>(
  value: { schemaVersion: Version; [key: string]: unknown },
): Extract<ParticipantModelPin, { schemaVersion: Version }>;
export function validateParticipantModelPin(value: unknown): ParticipantModelPin;
export function validateParticipantModelPin(value: unknown): ParticipantModelPin {
  const item = record(value);
  const schemaVersion = field(item, 'schemaVersion');
  const keys = schemaVersion === 'participant_model_pin_v3' ? ['schemaVersion', 'terraModelId', 'jevModelId']
    : schemaVersion === 'participant_model_pin_v2' ? [...KEYS, 'generationModelId'] : KEYS;
  if (Reflect.ownKeys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key))) return invalid();
  const terraModelId = field(item, 'terraModelId'), jevModelId = field(item, 'jevModelId');
  if (typeof terraModelId !== 'string' || !TERRA.test(terraModelId) ||
      typeof jevModelId !== 'string' || !JEV.test(jevModelId)) return invalid();
  if (schemaVersion === 'participant_model_pin_v3') return Object.freeze({ schemaVersion, terraModelId, jevModelId });
  const lunaModelId = field(item, 'lunaModelId');
  if (typeof lunaModelId !== 'string' || !LUNA.test(lunaModelId)) return invalid();
  const ids = { terraModelId, lunaModelId, jevModelId };
  if (schemaVersion === 'participant_model_pin_v1') return Object.freeze({ schemaVersion, ...ids });
  if (schemaVersion !== 'participant_model_pin_v2' || field(item, 'generationModelId') !== terraModelId) return invalid();
  return Object.freeze({ schemaVersion, ...ids, generationModelId: terraModelId });
}

// Check the actual provider response field before any adapter can fill it in.
export function requireExactParticipantModel(expectedId: string, returnedId: unknown): void {
  if (returnedId !== expectedId) throw new ParticipantModelPinError('model_mismatch');
}

function requireSamePin(expected: ParticipantModelPin, value: unknown): void {
  const actual = validateParticipantModelPin(value);
  // Each pin is already validated, including the v2 generation ID constraint.
  for (const [key, id] of Object.entries(expected)) requireExactParticipantModel(id, field(actual, key));
}

/** A plan approved without a pin keeps the old Worker runtime, including its
 * second trial. A pinned plan keeps its approved identities across trials and
 * restores. A restore may never switch runtimes or adopt deployment defaults.
 * restoredOptions is omitted only for a new trial.
 */
export function resolveWorkerParticipantModelPin({ approvedPin, configuredPin, restoredOptions }: {
  approvedPin?: unknown;
  configuredPin?: unknown;
  restoredOptions?: unknown;
}): ParticipantModelPin | null {
  const options = restoredOptions === undefined ? null : record(restoredOptions);
  const marked = options !== null && Object.hasOwn(options, 'participantModelPin');
  const jev = options === null ? undefined : field(options, 'jevResearch');
  if (options !== null && jev !== undefined && jev !== true && jev !== false) return invalid();
  if (approvedPin === undefined) {
    if (marked || jev === true) return invalid();
    return null;
  }
  const pin = validateParticipantModelPin(approvedPin);
  if (options !== null) {
    if (!marked || jev !== true) return invalid();
    requireSamePin(pin, field(options, 'participantModelPin'));
  }
  requireSamePin(pin, configuredPin);
  return pin;
}
