// Local (proposition-scoped) grounding contract: closed sets stay disjoint where the design requires it.
import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_ACTS, LOCAL_ASPECTS, LOCAL_ISSUE_STATES, LOCAL_NAME_STATES, LOCAL_SOURCES } from "../dialogue-model/runtime/local-grounding/contract.ts";
import type { LocalExtractionInput, LocalOwnImage, LocalOwnAnchor } from "../dialogue-model/runtime/local-grounding/contract.ts";

const ownImage: LocalOwnImage = { mimeType: "image/png", base64: "AAAA" };
const ownAnchors: LocalOwnAnchor[] = [{ id: "own-a", bbox: { x: 20, y: 10, w: 80, h: 60 }, centroid: { x: 60, y: 40 } }];
const extractionInput: LocalExtractionInput = { turn: 1, publicTurns: [{ turn: 1, speaker: "human", text: "四角があります" }],
  ownSlots: ["own-a"], issueSummary: "", ownImage, ownAnchors };
const { ownImage: _image, ...withoutImage } = extractionInput;
const { ownAnchors: _anchors, ...withoutAnchors } = extractionInput;
// @ts-expect-error An extraction needs the AI's image, not only opaque slot IDs.
const missingImage: LocalExtractionInput = withoutImage;
// @ts-expect-error The image needs its own private slot-to-pixel anchors.
const missingAnchors: LocalExtractionInput = withoutAnchors;

test("closed sets are frozen and duplicate-free", () => {
  for (const values of [LOCAL_ACTS, LOCAL_ASPECTS, LOCAL_ISSUE_STATES, LOCAL_NAME_STATES, LOCAL_SOURCES]) {
    assert.ok(Object.isFrozen(values));
    assert.equal(new Set(values).size, values.length);
  }
});

test("construal and naming are separate aspects and acts", () => {
  assert.ok(LOCAL_ASPECTS.includes("construal") && LOCAL_ASPECTS.includes("name"));
  assert.ok(LOCAL_ACTS.includes("construe") && LOCAL_ACTS.includes("name_propose"));
  assert.deepEqual([...LOCAL_NAME_STATES], ["no_name", "unclear", "not_agreed", "agreed", "unknown"]);
});

test("acknowledgment and unknown are distinct from agreement", () => {
  for (const act of ["acknowledge", "unknown", "agree", "name_accept"] as const) assert.ok(LOCAL_ACTS.includes(act));
});

test("extraction contract requires the same own-image and pixel-anchor shapes as v2", () => {
  assert.equal(extractionInput.ownImage, ownImage);
  assert.equal(extractionInput.ownAnchors, ownAnchors);
  assert.deepEqual(Object.keys(ownAnchors[0].bbox), ["x", "y", "w", "h"]);
  assert.equal(Object.hasOwn(missingImage, "ownImage"), false);
  assert.equal(Object.hasOwn(missingAnchors, "ownAnchors"), false);
});
