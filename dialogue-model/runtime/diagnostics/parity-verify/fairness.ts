import { allCalls, allHttp, amount, assertion, check, count, equal, hash, list, missing, profileHash, row, rows, shaLike } from "./core.ts";
import type { Check, Records } from "./core.ts";
import { replayChecks } from "./replay-records.ts";
import { explicitModelPolicy, requestedReturnedModel } from './model-checks.ts';

export function fairness(records: Records): Check[] {
  const out: Check[] = [];
  const profiles = [records.run, records.summary, ...records.trials];
  let reference: string | null = null;
  profiles.forEach((item, i) => {
    const id = `identity.profile.${i}`;
    if (!item || !Object.keys(row(item.profile)).length) { out.push(missing(id)); return; }
    const digest = profileHash(row(item.profile));
    out.push(assertion(id, digest === item.profileSha256 && (reference === null || reference === digest), "effective_profile_sha256"));
    reference ??= digest;
    const p = row(item.profile);
    out.push(assertion(`${id}.common_on`, p.referenceMemory === true && p.decisionMode === "jev" && p.humanReferent === true &&
      row(p.localGrounding).enabled === true && row(p.localGrounding).aiPublicClaims === true && p.initialObservation === "cache_required",
      "required_common_capabilities_enabled"));
    if (i >= 2) out.push(assertion(`${id}.identity`, row(item.identity).profile === digest, "trial_identity_profile"));
  });
  if (records.run?.manifest) out.push(assertion("identity.manifest", hash(records.run.manifest) === records.run.manifestSha256 &&
    (!records.summary || records.summary.manifestSha256 === records.run.manifestSha256), "manifest_sha256"));
  else out.push(missing("identity.manifest"));

  const scripts = new Set(records.trials.filter(t => t.stage === "main").map(t => t.scriptId));
  if (!scripts.size) out.push(missing("identity.labels", "paired_main_trials_missing"));
  for (const [index, script] of [...scripts].entries()) {
    const pair = records.trials.filter(t => t.stage === "main" && t.scriptId === script);
    const a = pair.find(t => t.label === "repair-first"), b = pair.find(t => t.label === "bypass-enabled");
    const prefix = `identity.pair.${index}`;
    if (!a || !b) { out.push(missing(prefix)); continue; }
    out.push(assertion(`${prefix}.unique`, pair.length === 2, "one_trial_per_label"));
    for (const key of ["image", "anchors", "memo", "prompts", "profile", "timeouts", "requestedModels"]) {
      const x = row(a.identity)[key], y = row(b.identity)[key];
      out.push(!shaLike(x) || !shaLike(y) ? missing(`${prefix}.${key}`) : assertion(`${prefix}.${key}`, x === y, "label_identity"));
    }
    const left = rows(a.turns), right = rows(b.turns);
    for (let j = 0; j < Math.max(left.length, right.length); j++) {
      const x = left[j], y = right[j];
      for (const [payload, material] of [["humanReferent", "humanMaterial"], ["actionInputs", "actionMaterial"]]) {
        const id = `${prefix}.turn.${j}.${payload}`;
        if (!x || !y || !list(x[payload]).length || !list(y[payload]).length || !list(x[material]).length || !list(y[material]).length) out.push(missing(id));
        else if (!equal(x[material], y[material])) out.push(check(id, "not_comparable", "upstream_material_difference"));
        else out.push(assertion(id, equal(x[payload], y[payload]), "same_material_payload_hashes"));
      }
    }
  }

  out.push(...replayChecks(records));
  const calls = allCalls(records);
  calls.forEach((c, i) => {
    out.push(c.status === "started" ? missing(`identity.model.${i}`, "response_not_reached") :
      c.model === null && c.status === "error" ? missing(`identity.model.${i}`, "response_model_unavailable") :
      assertion(`identity.model.${i}`, requestedReturnedModel(records, c), "exact_requested_response_model"));
  });
  out.push(assertion("identity.images", calls.every(c => c.imageCount === 0 || ["observation_initial", "observation_targeted"].includes(String(c.phase))), "images_only_observation"));
  return out;
}

/** Validate recorded Jev choice responses against recorded questions, without semantic scoring. */
export function wireValidation(records: Records): Check[] {
  const out: Check[] = [];
  for (const trial of records.trials) for (const [i, entry] of rows(trial.replay).entries()) {
    const tape = row(entry.tape), turn = row(list(tape.events).at(-1)).seq;
    const pair = rows(records.evidence?.pairedReplay).find(p => p.trialOrder === trial.order && p.turn === turn);
    if (!pair) { out.push(missing(`validation.jev.${trial.order}.${turn}`, "raw_questions_missing")); continue; }
    const requests = rows(row(pair.left).requests).filter(r => r.provider === "jev"), responses = rows(tape.jev);
    out.push(assertion(`validation.jev.${trial.order}.${turn}.count`, requests.length === responses.length && requests.length > 0, "recorded_questions_responses_paired"));
    requests.forEach((request, j) => {
      const payload = row(request.payload), response = responses[j] ?? {}, questions = row(payload.questions), answers = row(response.answers);
      const call = rows(trial.calls).filter(c => c.provider === "jev" && c.turn === turn)[j];
      const relation = explicitModelPolicy(records) ? requestedReturnedModel(records, {provider: 'jev', requestedModel: payload.model, model: response.model}) &&
        !!call && response.model === call.model : response.model === payload.model;
      const keys = Object.keys(questions).sort();
      const valid = keys.length > 0 && equal(keys, Object.keys(answers).sort()) && relation &&
        keys.every(key => {
          const q = row(questions[key]), a = row(answers[key]), probabilities = row(a.probabilities), labels = Object.keys(row(q.criteria)).sort();
          return q.type === "choice" && labels.length > 0 && a.type === "choice" && typeof a.choice === "string" && labels.includes(a.choice) &&
            equal(labels, Object.keys(probabilities).sort()) && Object.values(probabilities).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) &&
            (a.confidence === undefined || a.confidence === null || typeof a.confidence === "number" && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1) &&
            Object.keys(a).every(k => ["type", "choice", "probabilities", "confidence"].includes(k));
        });
      out.push(assertion(`validation.jev.${trial.order}.${turn}.${i}.${j}`, valid, "exact_model_question_keys_choice_and_probability_shape"));
      const cost = row(response.usage).cost;
      out.push(assertion(`validation.jev_cost.${trial.order}.${turn}.${j}`, !!call && (amount(cost) ? call.costUsd === cost : call.costUsd === null),
        "recorded_raw_usage_cost_matches_call_receipt"));
    });
    rows(tape.luna).forEach((entry, j) => {
      const response = row(entry.response), usage = row(response.usage), call = rows(trial.calls).filter(c => c.provider === "luna" && c.turn === turn)[j];
      const fields = ["inputTokens", "outputTokens"];
      out.push(assertion(`validation.luna_usage.${trial.order}.${turn}.${j}`, !!call && fields.every(field =>
        call[field] === (count(usage[field]) ? usage[field] : null)), "nested_complete_usage_fields_match_receipt_unknown_preserved"));
    });
  }
  return out;
}

export function publicPrivacy(records: Records): Check {
  const text = [...records.trials.flatMap(t => rows(t.publicTurns).map(e => e.text)),
    ...records.trials.flatMap(t => rows(t.turns).map(x => x.publicText)),
    ...(records.packets ?? []).flatMap(p => rows(p.value.prefix).map(x => x.text))].filter((s): s is string => typeof s === "string");
  if (!text.length) return missing("privacy.public", "public_utterances_missing");
  const instructions: string[] = [];
  for (const pair of rows(records.evidence?.pairedReplay)) for (const side of [row(pair.left), row(pair.right)]) {
    for (const req of rows(side.requests)) {
      const messages = Array.isArray(req.payload) ? rows(req.payload) : rows(row(req.payload).messages);
      for (const message of messages) if (message.role === "system" && typeof message.content === "string" && message.content.length >= 24)
        instructions.push(...message.content.split(/\r?\n/u).filter(line => line.trim().length >= 24).map(line => line.trim().slice(0, 80)));
    }
  }
  const compact = (s: string) => s.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
  const leaked = text.some(s => /data\s*:\s*image\s*\/|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}|\d+:(?:pub|local|ai)\d+/iu.test(s.normalize("NFKC")) ||
    instructions.some(i => compact(s).includes(compact(i))));
  return assertion("privacy.public", !leaked, "lexical_credentials_images_internal_claim_ids_and_recorded_prompt_line_echo_only");
}

export function cacheChecks(records: Records): Check[] {
  const out: Check[] = [], warm = records.warmup;
  const receipts = rows(records.evidence?.cache), warmReceipt = receipts.find(r => r.trialOrder === null);
  const warmCalls = rows(warm?.calls).filter(c => c.phase === "observation_initial"), posts = rows(warm?.http).filter(h => h.kind === "completion_post");
  out.push(!warm ? missing("cache.warmup") : assertion("cache.warmup", row(warm.audit).status === "MISS" && warmCalls.length === 1 &&
    posts.length >= 1 && posts.length <= 3 && warmCalls[0].status === "ok" && warmCalls[0].model === row(warm.policy).model &&
    warmCalls[0].requestedModel === row(warm.policy).model, "miss_one_complete_one_to_three_posts_validated_response"));
  records.trials.forEach((t, i) => {
    if (receipts.some(r => r.trialOrder === t.order && r.status === "not_attempted")) {
      out.push(missing(`cache.trial.${i}`, "setup_failed_before_cache_read"), missing(`cache.memo.identity.${i}`, "cache_read_not_attempted"));
      return;
    }
    out.push(!t.cache ? missing(`cache.trial.${i}`) : assertion(`cache.trial.${i}`, row(t.cache).status === "HIT" &&
      !rows(t.calls).some(c => c.phase === "observation_initial") && !rows(t.http).some(h => h.phase === "observation_initial" && h.kind === "completion_post"), "trial_hit_no_initial_observation"));
    if (t.cache && warm?.audit) out.push(assertion(`cache.key.${i}`, equal(row(t.cache).key, row(warm.audit).key), "warm_trial_cache_key"));
    if (warm?.memoSha256) out.push(assertion(`cache.memo.identity.${i}`, row(t.identity).memo === warm.memoSha256, "same_initial_memo"));
  });
  if (!warmReceipt) out.push(missing("cache.warmup.receipt", "raw_initial_memo_and_file_hash_missing"));
  else if (!warm) {
    out.push(warmReceipt.status !== "MISS" || warmReceipt.beforeSha256 !== null ? assertion("cache.warmup.receipt", false, "warm_cache_file_receipt") :
      missing("cache.warmup.receipt", "output_missing"));
  }
  else {
    out.push(assertion("cache.warmup.receipt", warmReceipt.status === "MISS" && warmReceipt.beforeSha256 === null && shaLike(warmReceipt.afterSha256) &&
      warmReceipt.afterSha256 === warm?.fileSha256 && warmReceipt.afterSha256 === records.summary?.cacheFileSha256, "warm_cache_file_receipt"));
  }
  receipts.forEach((r, i) => {
    if (r.status === "not_attempted") {
      const clean = typeof r.reason === "string" && /^setup_failed:[a-z_]{1,48}$/u.test(r.reason) &&
        !["memo", "memoSha256", "validated"].some(key => Object.hasOwn(r, key)) &&
        records.trials.some(t => t.order === r.trialOrder && !!t.failure && !t.cache);
      out.push(clean ? missing(`cache.receipt.${i}.memo`, "cache_read_not_attempted") : assertion(`cache.receipt.${i}.memo`, false, "not_attempted_receipt_contract"),
        missing(`cache.receipt.${i}.validation`, "cache_read_not_attempted"));
      return;
    }
    out.push(Object.hasOwn(r, "memo") && hash(r.memo) !== r.memoSha256 ? assertion(`cache.receipt.${i}.memo`, false, "raw_initial_memo_sha256") :
      !warm?.memoSha256 ? missing(`cache.receipt.${i}.memo`, "output_missing") : Object.hasOwn(r, "memo") ? assertion(`cache.receipt.${i}.memo`, r.memoSha256 === warm.memoSha256,
      "raw_initial_memo_sha256") : missing(`cache.receipt.${i}.memo`));
    if (Object.hasOwn(r, "memo")) out.push(assertion(`cache.receipt.${i}.memo_schema`, initialMemo(r.memo), "initial_memo_structure_and_no_targeted_reobservations"));
    const policyModel = row(warm?.policy).model ?? row(row(records.failure?.policy).value).model;
    const selfValid = r.validated === true && typeof r.requestedModel === "string" && r.requestedModel === r.returnedModel;
    out.push(selfValid && policyModel === undefined ? missing(`cache.receipt.${i}.validation`, "output_missing") :
      assertion(`cache.receipt.${i}.validation`, selfValid && r.requestedModel === policyModel, "memo_validation_and_exact_model"));
  });
  records.trials.forEach((t, i) => {
    const rs = receipts.filter(r => r.trialOrder === t.order);
    if (rs.length === 1 && rs[0].status === "not_attempted") { out.push(missing(`cache.immutable.${i}`, "cache_read_not_attempted")); return; }
    out.push(rs.length === 0 ? missing(`cache.immutable.${i}`, "per_trial_before_after_hash_missing") : assertion(`cache.immutable.${i}`, rs.length === 1 &&
      rs[0].status === "HIT" && shaLike(rs[0].beforeSha256) && rs[0].beforeSha256 === rs[0].afterSha256 && rs[0].afterSha256 === warmReceipt?.afterSha256,
      "cache_bytes_unchanged"));
  });
  // Ensure HTTP receipts are represented as either policy requests or POSTs, never mixed.
  out.push(assertion("cache.http_kinds", allHttp(records).every(h => h.kind === "policy_get" && h.method === "GET" || h.kind === "completion_post" && h.method === "POST"), "policy_get_separate"));
  return out;
}

function initialMemo(value: unknown): boolean {
  const memo = row(value), figures = rows(memo.figures);
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const textArray = (v: unknown) => Array.isArray(v) && v.every(text);
  return text(memo.observedAt) && Number.isFinite(Date.parse(memo.observedAt)) && figures.length > 0 &&
    new Set(figures.map(f => f.id)).size === figures.length && figures.every(f => {
      const region = row(f.region), analytic = row(f.analytic);
      return text(f.id) && ["x", "y", "w", "h"].every(k => typeof region[k] === "number" && Number.isFinite(region[k])) &&
        Number(region.w) > 0 && Number(region.h) > 0 && Array.isArray(f.holistic) && rows(f.holistic).every(h =>
          text(h.construal) && h.status === "hypothesis" && textArray(h.basis)) && textArray(analytic.shapes) &&
        text(analytic.composition) && textArray(analytic.relations) && textArray(f.unknowns) && Array.isArray(f.reobservations) && f.reobservations.length === 0;
    });
}
