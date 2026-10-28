/** The upstream API subset used by qr.ts; implementation is the MIT-licensed sibling module. */
type Segment = { readonly mode: object; readonly numChars: number };
type ErrorCorrection = { readonly ordinal: number; readonly formatBits: number };
export declare const qrcodegen: {
  QrSegment: { makeBytes(data: number[]): Segment };
  QrCode: {
    Ecc: { MEDIUM: ErrorCorrection };
    encodeSegments(segments: Segment[], ecl: ErrorCorrection, minVersion: number, maxVersion: number, mask: number, boostEcl: boolean): {
      readonly size: number;
      getModule(x: number, y: number): boolean;
    };
  };
};
