import { readFile, stat } from "node:fs/promises";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function detectMimeType(buffer) {
  if (buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  throw new Error("Supported image formats are PNG, JPEG, and WebP");
}

export async function readParticipantImage(filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) {
    throw new Error("Participant image must be a nonempty file no larger than 10 MiB");
  }
  const bytes = await readFile(filePath);
  return { mimeType: detectMimeType(bytes), base64: bytes.toString("base64") };
}
