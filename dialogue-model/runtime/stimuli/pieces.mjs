// Length units make the standard seven-piece tangram's total area eight.
const definitions = [
  ['L1', 'large-triangle', [[0, 0], [2, 0], [0, 2]]],
  ['L2', 'large-triangle', [[0, 0], [2, 0], [0, 2]]],
  ['M', 'medium-triangle', [[0, 0], [2, 0], [1, 1]]],
  ['S1', 'small-triangle', [[0, 0], [1, 0], [0, 1]]],
  ['S2', 'small-triangle', [[0, 0], [1, 0], [0, 1]]],
  ['Q', 'square', [[0, 0], [1, 0], [1, 1], [0, 1]]],
  ['P', 'parallelogram', [[0, 0], [1, 0], [2, 1], [1, 1]]],
];
export const PIECES = Object.freeze(definitions.map(([id, type, points]) =>
  Object.freeze({ id, type, points: Object.freeze(points.map(p => Object.freeze(p))) })));
