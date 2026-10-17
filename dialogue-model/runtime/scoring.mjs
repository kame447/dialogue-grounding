import { SLOTS } from './stimuli/board.mjs';

// Provisional orthographic normalization; semantic synonyms remain distinct.
export function normalizeName(name) {
  if (typeof name !== 'string') throw new TypeError('Names must be strings');
  return name.normalize('NFKC').trim().replace(/\s/gu, '').replace(/[\u30a1-\u30f6]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function validateKey(key) {
  if (!key || typeof key !== 'object') throw new TypeError('Invalid scoring key');
  const sides = ['human', 'ai'].map(side => {
    const map = key[side];
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== SLOTS.length || !SLOTS.every(slot => Object.hasOwn(map, slot) && typeof map[slot] === 'string' && map[slot].length)) throw new TypeError('Key must contain all six slots');
    const ids = SLOTS.map(slot => map[slot]);
    if (new Set(ids).size !== SLOTS.length) throw new TypeError('Key must be a bijection');
    return ids;
  });
  if (!sides[0].every(id => sides[1].includes(id))) throw new TypeError('Key sides must contain the same figure IDs');
}

function collect(map, submission) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) throw new TypeError('Submission must be a slot/name object');
  if (Object.keys(submission).some(slot => !SLOTS.includes(slot))) throw new TypeError('Unknown submission slot');
  const byFigure = Object.create(null), names = new Map(), unnamed = [];
  for (const slot of SLOTS) {
    const rawName = Object.hasOwn(submission, slot) ? submission[slot] : '';
    const name = normalizeName(rawName);
    const figureId = map[slot];
    byFigure[figureId] = { slot, rawName, name };
    if (!name) unnamed.push({ slot, figureId });
    else names.set(name, [...(names.get(name) ?? []), { slot, figureId }]);
  }
  const duplicateNames = [...names].filter(([, entries]) => entries.length > 1).map(([name, entries]) => ({ name, slots: entries.map(e => e.slot), figureIds: entries.map(e => e.figureId) }));
  return { byFigure, duplicateNames, unnamed };
}

export function scoreTrial({ key, humanSubmission, aiSubmission }) {
  validateKey(key);
  const human = collect(key.human, humanSubmission), ai = collect(key.ai, aiSubmission);
  const figures = SLOTS.map(slot => key.human[slot]).map(figureId => ({
    figureId,
    human: human.byFigure[figureId], ai: ai.byFigure[figureId],
    matched: Boolean(human.byFigure[figureId].name) && human.byFigure[figureId].name === ai.byFigure[figureId].name,
  }));
  const matchedCount = figures.filter(f => f.matched).length;
  return {
    provisional: true,
    normalization: 'NFKC・前後空白除去・内部空白除去・カタカナ→ひらがな（暫定）',
    success: matchedCount === SLOTS.length && human.duplicateNames.length === 0 && ai.duplicateNames.length === 0,
    matchedCount, total: SLOTS.length, figures,
    duplicateNames: { human: human.duplicateNames, ai: ai.duplicateNames },
    unnamed: { human: human.unnamed, ai: ai.unnamed },
  };
}
