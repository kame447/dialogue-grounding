import { isSupportedFigureCount } from '../../../dialogue-model/runtime/stimuli/figure-bank.ts';
import { observationInitialInstructions, OBSERVATION_LIMITS } from '../../../dialogue-model/runtime/observation/observe.ts';
import type { InitialObservationGeneration } from '../../../dialogue-model/runtime/observation/initial-observation-generation.ts';

const { figures, text, composition, list, holistic, basis } = OBSERVATION_LIMITS;
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const array = (items: object, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, object>) =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const texts = array(string(text), list);
const figure = object({
  id: { type: 'string' },
  holistic: array(object({
    construal: string(text),
    basis: array(string(text), basis, 1),
    status: { type: 'string', enum: ['hypothesis'] },
  }), holistic),
  analytic: object({ shapes: texts, composition: string(composition), relations: texts }),
  unknowns: texts,
});

export const INITIAL_OBSERVATION_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'terra_initial_observation_v1',
    strict: true,
    schema: object({ figures: array(figure, figures, figures) }),
  },
};

/** The proxy owns the schema; derive its size from the validated own-anchor envelope, never an incoming schema. */
export function initialObservationFormatForMessages(messages: readonly { role: string; content: unknown }[], generation?: InitialObservationGeneration) {
  try {
    if (messages[0]?.role !== 'system' || messages[1]?.role !== 'user' || typeof messages[1].content !== 'string') return null;
    const own = JSON.parse(messages[1].content);
    if (!own || Object.getPrototypeOf(own) !== Object.prototype || Object.keys(own).length !== 1 || !Array.isArray(own.ownAnchors)) return null;
    const count = own.ownAnchors.length;
    if (!isSupportedFigureCount(count) || messages[0].content !== observationInitialInstructions(count, generation) ||
        own.ownAnchors.some((a: unknown) => !a || typeof a !== 'object' || typeof (a as { id?: unknown }).id !== 'string' || !(a as { id: string }).id.trim()) ||
        new Set(own.ownAnchors.map((a: { id: string }) => a.id)).size !== count) return null;
    if (count === figures) return INITIAL_OBSERVATION_FORMAT;
    return { ...INITIAL_OBSERVATION_FORMAT, json_schema: { ...INITIAL_OBSERVATION_FORMAT.json_schema,
      schema: object({ figures: array(figure, count, count) }) } };
  } catch { return null; }
}
