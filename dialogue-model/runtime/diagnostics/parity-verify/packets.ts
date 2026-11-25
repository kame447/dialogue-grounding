import { assertion, check, combine, count, equal, hash, missing, row, rows } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";

const exact = (value: Row, keys: string[]) => equal(Object.keys(value).sort(), keys.slice().sort());
const publicEvent = (event: Row): Row => ({ turn: event.seq, speaker: event.speaker, text: event.text });

/** Public-only packet structure and checkpoint provenance, never semantic scoring. */
export function packetChecks(records: Records): Check[] {
  if (!records.packets?.length) return [missing("records.packets", "public_packets_missing")];
  const seen = new Set<string>();
  return records.packets.map((packet, i) => {
    const id = `records.packet.${i}`, value = packet.value, prefix = rows(value.prefix);
    const match = /^public-(0|[1-9]\d*)-(0|[1-9]\d*)\.packet\.json$/u.exec(packet.name);
    const structural = !!match && !seen.has(packet.name) && exact(value, ["prefix", "sha256"]) && Array.isArray(value.prefix) && prefix.length > 0 &&
      prefix.every((e, j) => exact(e, ["speaker", "turn", "text"]) && ["human", "ai"].includes(String(e.speaker)) &&
        typeof e.text === "string" && count(e.turn) && e.turn > 0 && (j === 0 || Number(prefix[j - 1].turn) < e.turn)) &&
      prefix.every(e => Number(e.turn) <= Number(match[2])) && prefix.at(-1)?.turn === Number(match[2]) && hash(value.prefix) === value.sha256;
    seen.add(packet.name);
    if (!structural || !match) return assertion(id, false, "public_packet_closed_schema_hash_order_checkpoint");
    const trial = records.trials.find(t => t.order === Number(match[1]));
    if (!trial) return missing(id, "packet_trial_record_missing");
    const checkpoint = Number(match[2]), sources = new Map<number, Row>();
    let conflict = false, incomplete = false;
    const add = (event: Row) => {
      if (!count(event.seq) || event.seq === 0 || typeof event.text !== "string" || !["human", "ai"].includes(String(event.speaker))) { conflict = true; return; }
      if (event.seq > checkpoint) return;
      const projected = publicEvent(event), prior = sources.get(event.seq);
      if (prior && !equal(prior, projected)) conflict = true;
      sources.set(event.seq, projected);
    };
    if (Array.isArray(trial.publicTurns)) {
      const events = rows(trial.publicTurns);
      if (events.some((e, j) => !count(e.seq) || j > 0 && Number(events[j - 1].seq) >= Number(e.seq))) conflict = true;
      if (trial.completed === true && events.length > 0 && Number(events.at(-1)?.seq) < checkpoint)
        return assertion(id, false, "packet_checkpoint_beyond_completed_trial");
      events.forEach(add);
    }
    for (const replay of rows(trial.replay)) rows(row(replay.tape).events).forEach(add);
    for (const turn of rows(trial.turns)) {
      if (!count(turn.turn) || turn.turn + 1 > checkpoint) continue;
      const trace = rows(turn.trace).find(t => t.status === "committed");
      if (!trace || typeof turn.publicText !== "string" || typeof trace.publicSpeech !== "string") { incomplete = true; continue; }
      if (trace.publicSpeech !== turn.publicText) conflict = true;
      else add({ seq: turn.turn + 1, speaker: "ai", text: turn.publicText });
    }
    if (conflict) return assertion(id, false, "public_event_sources_contradict");
    for (const event of sources.values()) if (event.speaker === "ai" && !rows(trial.turns).some(t => Number(t.turn) + 1 === event.turn &&
      rows(t.trace).some(trace => trace.status === "committed" && trace.publicSpeech === event.text) && t.publicText === event.text)) incomplete = true;
    // A packet contradicting any known event is already a mismatch, even if other evidence is absent.
    if (prefix.some(e => sources.has(Number(e.turn)) && !equal(sources.get(Number(e.turn)), e))) return assertion(id, false, "packet_differs_from_recorded_public_event");
    const expected = [...sources].sort(([a], [b]) => a - b).map(([, e]) => e);
    if (incomplete || expected.length !== checkpoint || expected.some((e, j) => e.turn !== j + 1)) return missing(id, "checkpoint_public_prefix_evidence_incomplete");
    return assertion(id, equal(prefix, expected), "packet_matches_trial_public_prefix_at_checkpoint");
  });
}

export function requiredPackets(records: Records, trial: Row): Check {
  if (!records.packets) return missing("storage.packets");
  const names = rows(trial.turns).flatMap(t => [t.turn, Number(t.turn) + 1].map(seq => `public-${trial.order}-${seq}.packet.json`));
  const found = names.length > 0 && names.every(name => records.packets!.some(p => p.name === name));
  return combine("storage.packets", [found ? check("storage.packet_presence", "pass", "checkpoint_files_present") : missing("storage.packet_presence"),
    ...packetChecks({ ...records, packets: records.packets.filter(p => p.name.startsWith(`public-${trial.order}-`)) })], "packet_structure_and_checkpoint_provenance");
}
