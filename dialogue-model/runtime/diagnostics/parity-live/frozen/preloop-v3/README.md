# Frozen pre-loop (legacy, style) runtime files — inspection only

These files are copies of the runtime as it was at the legacy (58a9511) and style (07116ae) commits, kept only so the S4 dynamic replay can reproduce the
requests of records made by those lineages. Each file is the original blob; only its relative import specifiers were rewritten (files inside the frozen set
point at each other, everything else at the current module of the same path).

- Never import these from a live, participant or runtime path. `tests/s4-preloop-v3-frozen.test.ts` enforces it.
- Never edit them by hand. `tests/fixtures/s4/preloop-v3-frozen-pins.json` pins every file (source blob, source SHA-256, frozen SHA-256).
- Their extension is `.mts` so the runtime type check does not include them.
