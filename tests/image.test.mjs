import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readParticipantImage } from "../dialogue-model/runtime/image.mjs";

test("real PNG content is encoded and non-images are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dialogue-image-"));
  try {
    const imagePath = join(dir, "image.blob");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2qwAAAABJRU5ErkJggg==", "base64");
    await writeFile(imagePath, image);
    assert.deepEqual(await readParticipantImage(imagePath), {
      mimeType: "image/png", base64: image.toString("base64"),
    });
    const otherPath = join(dir, "example.png");
    await writeFile(otherPath, "not actually an image");
    await assert.rejects(readParticipantImage(otherPath), /Supported image formats/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
