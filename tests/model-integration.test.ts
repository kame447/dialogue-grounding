import { fileURLToPath } from 'node:url';
process.env.S2_SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
// Fixed author suites copied byte-for-byte; only this entry selects the subject.
await import('./support/s2-integration/profile-aggregate.test.ts');
await import('./support/s2-integration/collector.test.ts');
await import('./support/s2-integration/integration.test.ts');
await import('./support/s2-integration/sparse-completeness.test.ts');
