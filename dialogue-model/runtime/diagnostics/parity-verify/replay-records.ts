import { allCalls, allHttp, assertion, check, combine, count, equal, hash, list, META_KEYS, missing, omit, row, rows, shaLike } from "./core.ts";
import type { Check, Records, Row } from "./core.ts";

/** The sole permitted projection is an image URL value, never a whole message/body. */
function projectionAudit(value: unknown, ownImage: Row, path: string[] = []): { count: number; valid: boolean } {
  if (typeof value === "string" && /^data\s*:\s*image\s*\//iu.test(value)) return { count: 0, valid: false };
  if (Array.isArray(value)) return value.reduce<{ count: number; valid: boolean }>((a, v, i) => {
    const b = projectionAudit(v, ownImage, [...path, String(i)]); return { count: a.count + b.count, valid: a.valid && b.valid };
  }, { count: 0, valid: true });
  const object = row(value);
  if (object.projection === "own_image_bytes_sha256") {
    const location = path.join(".");
    return { count: 1, valid: /^messages\.\d+\.content\.\d+\.image_url\.url$/u.test(location) &&
      equal(Object.keys(object).sort(), ["byteSha256", "mimeType", "projection"]) &&
      ["image/png", "image/jpeg", "image/webp"].includes(String(object.mimeType)) && shaLike(object.byteSha256) && equal(object, ownImage) };
  }
  return Object.entries(object).reduce<{ count: number; valid: boolean }>((a, [key, v]) => {
    const b = projectionAudit(v, ownImage, [...path, key]); return { count: a.count + b.count, valid: a.valid && b.valid };
  }, { count: 0, valid: true });
}

export function replayChecks(records: Records): Check[] {
  const out: Check[] = [], pairs = rows(records.evidence?.pairedReplay), seen = new Set<string>();
  const uniqueIds = (ids: unknown[]) => ids.every(id => count(id) && id > 0) && new Set(ids).size === ids.length;
  const sameIds = (a: unknown[], b: unknown[]) => uniqueIds(a) && uniqueIds(b) && a.length === b.length && a.every(id => b.includes(id));
  // Account for EVERY POST receipt, including one whose IDs match no replay request.
  // Per-request selection alone must never make an unmatched receipt disappear.
  const allPosts = allHttp(records).filter(h => h.kind === "completion_post" || h.method === "POST");
  const lunaCalls = allCalls(records).filter(c => c.provider === "luna");
  out.push(assertion("replay.http_receipts", uniqueIds(allPosts.map(h => h.sendId)) &&
    allPosts.every(h => h.kind === "completion_post" && h.method === "POST" && lunaCalls.some(c =>
      c.id === h.callId && list(c.sendIds).includes(h.sendId) && c.phase === h.phase)) &&
    lunaCalls.every(c => sameIds(list(c.sendIds), allPosts.filter(h => h.callId === c.id).map(h => h.sendId))),
    "one_to_one_all_http_receipts_and_native_send_ids"));
  const expected = records.trials.flatMap(t => rows(t.replay).map(r => ({ order: t.order, turn: row(list(row(r.tape).events).at(-1)).seq })));
  if (!pairs.length) out.push(missing("replay.prewire", "both_label_raw_requests_missing"));
  if (records.evidence?.normalizedEnvelopeFields) out.push(assertion("replay.normalization", equal(records.evidence.normalizedEnvelopeFields, META_KEYS), "fixed_envelope_key_list"));
  for (const [i, pair] of pairs.entries()) {
    const id = `replay.${i}`, key = `${pair.trialOrder}:${pair.turn}`, a = row(pair.left), b = row(pair.right);
    const trial = records.trials.find(t => t.order === pair.trialOrder);
    const native = rows(trial?.replay).find(r => row(list(row(r.tape).events).at(-1)).seq === pair.turn), tape = row(native?.tape);
    out.push(assertion(`${id}.binding`, expected.some(e => e.order === pair.trialOrder && e.turn === pair.turn) && !seen.has(key), "recorded_trial_turn_binding")); seen.add(key);
    out.push(assertion(`${id}.labels`, a.label === "repair-first" && b.label === "bypass-enabled", "both_labels_captured"));
    if (!Object.hasOwn(a, "material") || !Object.hasOwn(b, "material")) { out.push(missing(`${id}.materials`)); continue; }
    out.push(assertion(`${id}.materials.sha256`, hash(a.material) === a.materialSha256 && hash(b.material) === b.materialSha256, "projected_material_sha256"));
    const different = !equal(a.material, b.material), left = rows(a.requests), right = rows(b.requests);
    const incomparable = (name: string) => check(name, "not_comparable", "upstream_material_difference");
    out.push(different ? incomparable(`${id}.parity`) : !left.length || !right.length ? missing(`${id}.parity`) :
      assertion(`${id}.parity`, equal(left.map(r => omit(r, META_KEYS)), right.map(r => omit(r, META_KEYS))), "complete_projected_payloads_and_all_nonmetadata_fields"));
    for (const [sideName, side] of [["left", a], ["right", b]] as const) {
      const material = row(side.material), requests = rows(side.requests), originalRequests = rows(tape.expectedRequests);
      out.push(different ? incomparable(`${id}.${sideName}.material_binding`) : assertion(`${id}.${sideName}.material_binding`,
        ["state", "events"].every(k => equal(material[k], tape[k])) && equal(material.profile, trial?.profile) &&
        ["luna", "jev", "reobservations"].every(k => !Object.hasOwn(material, k) || equal(material[k], tape[k])), "raw_frozen_material_binding"));
      const boundary = row(material.boundary), domainKnown = boundary.luna === "canonical_http_json" && boundary.jev === "canonical_http_json" && boundary.hashScheme === "canonical_json_sha256_not_raw_body_bytes";
      out.push(domainKnown ? check(`${id}.${sideName}.domain`, "pass", "canonical_http_json_boundary") : missing(`${id}.${sideName}.domain`, "full_http_hash_domains_not_recorded"));
      const bindings: Check[] = [different ? incomparable(`${id}.${sideName}.count`) : assertion(`${id}.${sideName}.count`, requests.length > 0 && requests.length === originalRequests.length, "request_count_order")];
      out.push(...bindings);
      requests.forEach((request, j) => {
        const rid = `${id}.${sideName}.${j}`, original = originalRequests[j] ?? {}, body = row(request.payload);
        const provider = request.provider;
        const integrity = Object.hasOwn(request, "payload") ? assertion(`${rid}.projected_sha256`, hash(request.payload) === request.payloadSha256, "post_projection_canonical_payload_sha256") : missing(`${rid}.projected_sha256`);
        out.push(integrity); bindings.push(integrity);
        if (!domainKnown || request.payloadDomain !== "canonical_http_json") { const absent = missing(`${rid}.wire_domain`, "full_http_hash_domain_missing"); out.push(absent); bindings.push(absent); return; }
        const projection = projectionAudit(request.payload, row(row(material.own).ownImage));
        const projectionCheck = assertion(`${rid}.projection`, projection.valid && (provider === "luna" || projection.count === 0), "only_enumerated_own_image_url_projection");
        out.push(projectionCheck); bindings.push(projectionCheck);
        const associated = different ? incomparable(`${rid}.recorded_hash_binding`) : assertion(`${rid}.recorded_hash_binding`, request.provider === original.provider && request.phase === original.phase &&
          shaLike(request.preProjectionPayloadSha256) && request.preProjectionPayloadSha256 === original.requestSha256, "pre_projection_hash_association_to_recorded_http");
        out.push(associated); bindings.push(associated);
        const preimage = projection.count ? missing(`${rid}.original_recomputation`, "original_image_bytes_not_present_self_reported_hash_is_not_full_proof") :
          assertion(`${rid}.original_recomputation`, hash(request.payload) === request.preProjectionPayloadSha256, "independent_pre_projection_http_hash");
        out.push(preimage); bindings.push(preimage);
        const calls = rows(trial?.calls).filter(c => c.provider === provider && c.turn === pair.turn);
        const prior = requests.slice(0, j).filter(r => r.provider === provider).length, call = calls[prior];
        if (provider === "luna") {
          const explicit = row(row(trial?.profile).lunaRequest).maxCompletionTokens;
          const fields = assertion(`${rid}.http_fields`, equal(Object.keys(body).sort(), [...(explicit === null ? [] : ["max_completion_tokens"]), "messages", "purpose"].sort()) &&
            body.purpose === "dialogue_turn" && Array.isArray(body.messages) && (explicit === null || body.max_completion_tokens === explicit), "exact_luna_body_keys_purpose_explicit_limit");
          out.push(fields); bindings.push(fields);
          const diagnostic = different ? incomparable(`${rid}.messages_binding`) : assertion(`${rid}.messages_binding`, shaLike(request.completeMessagesSha256) && request.completeMessagesSha256 === original.messagesSha256 &&
            request.completeMessagesSha256 === call?.requestSha256, "complete_messages_diagnostic_association_only");
          out.push(diagnostic); bindings.push(diagnostic);
          if (!projection.count) out.push(assertion(`${rid}.messages_recomputation`, Array.isArray(body.messages) && hash(body.messages) === request.completeMessagesSha256, "independent_complete_messages_hash"));
          else out.push(missing(`${rid}.messages_recomputation`, "original_image_bytes_not_present"));
          if (original.actualSendMeasured !== true) { const absent = missing(`${rid}.actual_http`, "actual_luna_send_not_measured"); out.push(absent); bindings.push(absent); }
          else {
            const sends = list(original.sendIds), receipts = rows(trial?.http).filter(h =>
              (h.kind === "completion_post" || h.method === "POST") && (h.callId === call?.id || sends.includes(h.sendId)));
            const actual = different ? incomparable(`${rid}.actual_http`) : assertion(`${rid}.actual_http`, !!call && sends.length > 0 && receipts.length === sends.length &&
              sameIds(sends, receipts.map(h => h.sendId)) && equal(sends, call.sendIds) && receipts.every(h => h.kind === "completion_post" && h.method === "POST" &&
                h.callId === call.id && h.phase === request.phase && h.hashScheme === "canonical_json_sha256" && h.requestSha256 === original.requestSha256) &&
              call.expectedHttpRequestSha256 === original.requestSha256 && call.httpRequestSha256 === original.requestSha256, "each_actual_post_and_retry_bound_to_full_http_hash");
            out.push(actual); bindings.push(actual);
          }
        } else if (provider === "jev") {
          const actual = different ? incomparable(`${rid}.actual_http`) : assertion(`${rid}.actual_http`, !!call && call.requestSha256 === original.requestSha256 && list(call.sendIds).length > 0,
            "jev_call_full_http_hash_binding"); out.push(actual); bindings.push(actual);
        } else { const invalid = assertion(`${rid}.provider`, false, "known_provider_required"); out.push(invalid); bindings.push(invalid); }
      });
      out.push(different ? incomparable(`${id}.${sideName}.wire_binding`) : combine(`${id}.${sideName}.wire_binding`, bindings, "independent_http_binding_separate_from_projected_payload_parity"));
    }
  }
  expected.forEach((e, i) => { if (!seen.has(`${e.order}:${e.turn}`)) out.push(missing(`replay.required.${i}`, "paired_raw_requests_missing")); });
  records.trials.forEach((trial, i) => rows(trial.replay).forEach((r, j) => {
    const projected = (v: unknown) => rows(v).map(({ provider, phase, requestSha256 }) => ({ provider, phase, requestSha256 }));
    out.push(Array.isArray(row(r.tape).expectedRequests) && Array.isArray(row(r.result).requests) ? assertion(`replay.recorded.${i}.${j}`,
      equal(projected(row(r.tape).expectedRequests), projected(row(r.result).requests)), "recorded_http_hash_list_consistency_only") : missing(`replay.recorded.${i}.${j}`));
  }));
  return out;
}
