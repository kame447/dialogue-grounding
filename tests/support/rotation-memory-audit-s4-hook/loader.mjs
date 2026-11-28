// D 監査（AquaGauss）: URL が MUTATE_SUFFIX で終わる module の source の MUTATE_FROM（ちょうど1か所）を MUTATE_TO へ置き換える。
// 指紋の計算（promptSourceManifest）は disk の file を読むので、変えた module も元の指紋のまま = S4 から見て「登録された版の runtime が、
// 登録された文面と1字だけ違う文面を送った」状態になる。S4 が自分の写しと照合していなければ、この違いは見つからない。
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const suffix = process.env.MUTATE_SUFFIX;
  if (!suffix || !url.endsWith(suffix) || result.source == null) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const from = process.env.MUTATE_FROM ?? '', to = process.env.MUTATE_TO ?? '';
  const at = text.indexOf(from);
  if (from === '' || at < 0) throw new Error('mutation site not found');
  if (text.indexOf(from, at + 1) >= 0) throw new Error('mutation site not unique');
  return { ...result, source: text.slice(0, at) + to + text.slice(at + from.length) };
}
