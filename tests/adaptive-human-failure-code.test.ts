// Issue #141: a stopped driver must say why, using closed codes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {failureCode} from '../dialogue-model/runtime/diagnostics/adaptive-human/harness.ts';

test('failure codes pass through; any other message is replaced', () => {
  for (const code of ['participant_ui_timeout', 'participant_ai_error', 'invalid_adaptive_human_response', 'browser_evaluation_failed'])
    assert.equal(failureCode(new Error(code)), code);
  for (const value of [new Error('Bearer secret-token'), new Error('Unexpected token < in JSON at position 0'), new Error(''), 'participant_ui_timeout', null])
    assert.equal(failureCode(value), 'unexpected_error');
});
