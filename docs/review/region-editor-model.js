const RegionEditorModel = (() => {
  const REVIEW_ID = 'tangram-expression-review-20261128';
  const ROUND2_ID = 'tangram-regions-round2-20261128';
  const ROUND2_HASH = '97f1fc831d923fc43bf0249adc5add519ca3c08873004e3dd118084134e0281a';
  const UNCONFIRMED = '未確認';
  const knownRegions = {
    F6: [['1', '2a', '3']],
    F11: [['1', '2', '3b', '4', '5'], ['3a', '7']],
    F19: [['1', '2a', '3']],
    F20: [['1b', '2', '3']],
    F30: [['1a', '2', '5'], ['1b', '3', '4']],
  };
  const fail = message => { throw new Error(message); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const normalized = text => text.normalize('NFKC').trim();

  function atomInfo(item) {
    const ids = item.atoms.map(atom => atom.id);
    const pieces = new Map();
    item.atoms.forEach(atom => {
      const piece = String(atom.sourcePiece);
      if (!pieces.has(piece)) pieces.set(piece, []);
      pieces.get(piece).push(atom.id);
    });
    return { ids, pieces, order: new Map(ids.map((id, index) => [id, index])) };
  }

  function expand(info, value, aliases = true) {
    if (typeof value !== 'string') fail('部品番号は文字列で指定してください。');
    const token = normalized(value).toLowerCase();
    if (info.order.has(token)) return [token];
    if (aliases && info.pieces.has(token)) return info.pieces.get(token).slice();
    fail('未知の部品番号です: ' + (value || '空欄'));
  }

  function validGroups(item, groups, aliases = true, complete = true) {
    const info = atomInfo(item), seen = new Set();
    if (!Array.isArray(groups) || groups.length === 0) fail('部品番号がありません。');
    const result = groups.map(group => {
      if (!Array.isArray(group) || group.length === 0) fail('空のまとまりがあります。');
      const tokens = group.flatMap(token => expand(info, token, aliases));
      for (const token of tokens) {
        if (seen.has(token)) fail('部品番号が重複しています: ' + token);
        seen.add(token);
      }
      return tokens.sort((a, b) => info.order.get(a) - info.order.get(b));
    });
    const missing = info.ids.filter(id => !seen.has(id));
    if (complete && missing.length) fail('不足している部品番号: ' + missing.join('、'));
    return result;
  }

  function parse(item, text) {
    if (typeof text !== 'string') fail('まとまりの式を入力してください。');
    return validGroups(item, normalized(text).split('/').map(group => group.split('+')));
  }

  function format(item, groups) {
    const info = atomInfo(item);
    return validGroups(item, groups, true, false).map(group => {
      const present = new Set(group), emitted = new Set(), tokens = [];
      for (const id of group) {
        if (emitted.has(id)) continue;
        const piece = String(item.atoms[info.order.get(id)].sourcePiece);
        const atoms = info.pieces.get(piece);
        if (atoms.every(atom => present.has(atom))) {
          tokens.push(piece);
          atoms.forEach(atom => emitted.add(atom));
        } else {
          tokens.push(id); emitted.add(id);
        }
      }
      return tokens.join('+');
    }).join(' / ');
  }

  function mask(item, group) {
    if (!Array.isArray(group)) fail('まとまりを配列で指定してください。');
    const info = atomInfo(item), ids = new Set(group.flatMap(token => expand(info, token)));
    const value = [...ids].reduce((sum, id) => sum + 2 ** info.order.get(id), 0);
    if (!Number.isSafeInteger(value)) fail('部品数が扱える範囲を超えています。');
    return value;
  }

  function field(row, key, fallback) {
    if (!Object.hasOwn(row, key)) return fallback;
    if (typeof row[key] !== 'string') fail(key + ' は文字列で指定してください。');
    return row[key];
  }

  function state(item, groups, status = UNCONFIRMED, note = '', draft) {
    const checked = validGroups(item, groups, false), expression = format(item, checked);
    const savedDraft = draft === undefined ? expression : draft;
    if (typeof savedDraft !== 'string' || typeof status !== 'string' || typeof note !== 'string') fail('状態の形式が正しくありません。');
    return { figureId: item.figureId, groups: checked,
      status: savedDraft === expression && status.trim() ? status : UNCONFIRMED, note, draft: savedDraft };
  }

  function initialStates(data) {
    return data.items.map(item => state(item, item.initialGroups));
  }

  function currentRows(data, currentStates) {
    if (currentStates === undefined) return initialStates(data);
    if (!Array.isArray(currentStates)) fail('現在の状態の形式が正しくありません。');
    const found = new Map();
    for (const row of currentStates) {
      if (!row || typeof row !== 'object' || found.has(row.figureId)) fail('現在の図形状態に重複または不正な行があります。');
      found.set(row.figureId, row);
    }
    if (found.size !== data.items.length || data.items.some(item => !found.has(item.figureId))) fail('現在の図形一覧が一致しません。');
    return data.items.map(item => {
      const row = found.get(item.figureId);
      return state(item, row.groups, field(row, 'status', UNCONFIRMED), field(row, 'note', ''), field(row, 'draft', undefined));
    });
  }

  function migrateWholePieces(item, groups) {
    const fixed = item.figureId === 'F16' ? item.initialGroups : knownRegions[item.figureId];
    if (!fixed) return groups;
    const used = new Set(fixed.flat());
    return validGroups(item, [...fixed, ...groups.map(group => group.filter(atom => !used.has(atom))).filter(group => group.length)], false);
  }

  function readText(text) {
    const rows = [];
    for (const line of normalized(text).split(/\r?\n/u)) {
      const value = line.trim();
      if (!value || value === '図形のまとまりの確認結果') continue;
      const match = /^(F\d+)\s*:\s*(.*?)\s*(?:\(([^()]*)\))?$/iu.exec(value);
      if (!match) fail('読み取れない行があります: ' + value);
      rows.push({ figureId: match[1].toUpperCase(), expression: match[2], status: match[3] || UNCONFIRMED });
    }
    return rows;
  }

  function importResults(data, text, currentStates) {
    if (typeof text !== 'string' || !text.trim()) fail('取り込む結果を入力してください。');
    const states = currentRows(data, currentStates), items = new Map(data.items.map(item => [item.figureId, item]));
    const byId = new Map(states.map(row => [row.figureId, row]));
    let sourceKind = 'legacy_text', rows;
    if (/^[\s]*[\[{]/u.test(text)) {
      let source;
      try { source = JSON.parse(text); } catch { fail('JSONを読み取れません。内容を確認してください。'); }
      if (!source || typeof source !== 'object') fail('結果の形式が正しくありません。');
      if (source.reviewId === REVIEW_ID) {
        if (!data.dataSha256 || source.dataSha256 !== data.dataSha256) fail('図形データの識別情報が一致しません。');
        sourceKind = 'expression_json';
      } else if (source.reviewId === ROUND2_ID) {
        if (source.proposalSha256 !== ROUND2_HASH) fail('前回の確認対象データが一致しません。');
        sourceKind = 'round2_json';
      } else fail('対応していない確認結果です。');
      rows = source.results;
    } else rows = readText(text);
    if (!Array.isArray(rows) || rows.length === 0) fail('図形の結果がありません。');
    const seen = new Set(), cutUpdatedIds = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !items.has(row.figureId)) fail('未知の図形IDです: ' + (row && row.figureId));
      if (seen.has(row.figureId)) fail('図形IDが重複しています: ' + row.figureId);
      seen.add(row.figureId);
      const item = items.get(row.figureId), previous = byId.get(row.figureId);
      let next;
      if (sourceKind === 'legacy_text') {
        let groups = parse(item, row.expression), status = row.status;
        const explicitFragments = /\d+[a-z]/iu.test(row.expression);
        if (!explicitFragments && (Object.hasOwn(knownRegions, item.figureId) || item.figureId === 'F16')) {
          groups = migrateWholePieces(item, groups); status = UNCONFIRMED; cutUpdatedIds.push(item.figureId);
        }
        next = state(item, groups, status, previous.note);
      } else if (sourceKind === 'round2_json') {
        const initial = validGroups(item, item.initialGroups, false);
        const status = same(previous.groups, initial) ? field(row, 'status', UNCONFIRMED) : UNCONFIRMED;
        next = state(item, previous.groups, status, field(row, 'note', previous.note), previous.draft);
      } else {
        next = state(item, row.groups, field(row, 'status', UNCONFIRMED), field(row, 'note', ''), field(row, 'draft', undefined));
      }
      byId.set(item.figureId, next);
    }
    return { states: data.items.map(item => byId.get(item.figureId)), importedCount: rows.length,
      cutUpdatedIds, sourceKind, sourceText: text };
  }

  function exportResults(data, states) {
    if (typeof data.dataSha256 !== 'string' || !data.dataSha256) fail('図形データの識別情報がありません。');
    return JSON.stringify({ reviewId: REVIEW_ID, dataSha256: data.dataSha256, results: currentRows(data, states) }, null, 2);
  }

  return { parse, format, mask, importResults, initialStates, exportResults };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RegionEditorModel;
