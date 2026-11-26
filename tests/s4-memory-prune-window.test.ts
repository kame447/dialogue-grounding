import assert from "node:assert/strict";
import test from "node:test";
import { s4LocalReverify } from "../dialogue-model/runtime/diagnostics/parity-verify/intervention-records.ts";
import { verifyLocalUpdate } from "../dialogue-model/runtime/local-grounding/verify.ts";
import type { PublicTurn } from "../dialogue-model/runtime/local-grounding/contract.ts";
import {
  CLAIM_PRUNE_V2, REFERENCE_LIMITS, applyReferenceUpdate, createReferenceGraph,
} from "../dialogue-model/runtime/memory/reference-graph.mjs";

const slots = ["s-a", "s-b", "s-c", "s-d", "s-e", "s-f"];
const quote = "左の形に小さな切れ込みが見えます。";

for (const turn of [33, 153]) {
  test(`S4 rechecks a pruned transcript with ${turn} public events`, () => {
    const graph = createReferenceGraph({ slots, memoryPruneVersion: CLAIM_PRUNE_V2 });
    const events = Array.from({ length: turn }, (_, i) => ({
      seq: i + 1,
      speaker: i % 2 === 0 ? "human" as const : "ai" as const,
      text: i + 1 === turn ? quote : "形を確かめています。",
    }));
    const publicTurns: PublicTurn[] = events.slice(-REFERENCE_LIMITS.publicTurns)
      .map(({ seq, speaker, text }) => ({ turn: seq, speaker, text }));
    const segments = [{ segmentId: "part", quote, targets: [slots[0]], aspect: "part" as const,
      proposition: "小さな切れ込み", name: null, linkedIssueId: null, respondsToTurn: null }];
    const verdicts = [{ segmentId: "part", act: "assert" as const, respondsToClaimId: null, rawScore: null }];
    const verified = verifyLocalUpdate({ graph, turn, publicTurns, segments, verdicts });
    assert.deepEqual(verified.rejected, []);
    assert.equal(verified.operations.length, 1);
    const after = applyReferenceUpdate(graph, { expectedRevision: graph.revision, turn, operations: verified.operations },
      { publicTurns, generationSucceeded: true });
    const trace = { turnIndex: turn, local: { status: "committed", localStatus: "ok",
      extractor: { segments }, classifier: { verdicts }, claims: verified.operations,
      verification: { rejected: verified.rejected } } };
    const tape = { state: { graph }, events };
    assert.equal(s4LocalReverify(tape, trace, "holistic_v5", after), "ok");
    assert.equal(s4LocalReverify(tape, { ...trace, local: { ...trace.local, claims: [] } }, "holistic_v5", after), "mismatch");
  });
}
