import { OBSERVATION_LIMITS } from '../../../dialogue-model/runtime/observation/observe.ts';

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
