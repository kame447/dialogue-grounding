// Decision 0002: private visual material, never a name agreement or an answer key.
import type { LocalAspect, LocalOwnAnchor, LocalOwnImage } from "../local-grounding/contract.ts";

export type ObservationRegion = LocalOwnAnchor["bbox"];
export type ObservationIssue = {
  aspect: LocalAspect;
  question: string;
  partnerConstrual: string | null;
};
export type HolisticObservation = {
  construal: string;
  /** Descriptions of the image parts supporting this interpretation. */
  basis: string[];
  status: "hypothesis";
};
export type AnalyticObservation = { shapes: string[]; composition: string; relations: string[] };
export type ReobservedFigure = { figureId: string; supports: string[]; contradicts: string[]; unknown: string[] };
export type ReobservationEntry = ReobservedFigure & {
  /** Program-assigned UTC timestamp; never supplied by Luna. */
  observedAt: string;
  issue: ObservationIssue;
};
export type ObservationFigure = {
  id: string;
  /** Program-copied pixel bbox of this figure's own anchor. */
  region: ObservationRegion;
  holistic: HolisticObservation[];
  analytic: AnalyticObservation;
  unknowns: string[];
  reobservations: ReobservationEntry[];
};
export type ObservationMemo = { observedAt: string; figures: ObservationFigure[] };
export type ReobservationResult = {
  observedAt: string;
  issue: ObservationIssue;
  figures: ReobservedFigure[];
};
export type ObservationInput = { ownImage: LocalOwnImage; ownAnchors: readonly LocalOwnAnchor[] };
export type ReobservationInput = ObservationInput & {
  memo: ObservationMemo;
  figureIds: readonly string[];
  issue: ObservationIssue;
};
export type ObservationOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ObservationObserver = {
  /** Pipeline calls once per trial; the factory holds no cross-trial cache. */
  observeAll(input: ObservationInput, options?: ObservationOptions): Promise<ObservationMemo>;
  reobserve(input: ReobservationInput, options?: ObservationOptions): Promise<ReobservationResult>;
};
