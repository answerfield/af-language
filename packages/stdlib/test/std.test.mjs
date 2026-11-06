// The generated module. That std.af compiles without any diagnostic and is formatted, the tests of
// @answerfield/language check (test/stdlib.test.ts), which load it from this package.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as stdlib from '@answerfield/stdlib';

test('das Modul enthält std.af', () => {
  assert.equal(stdlib.STD, readFileSync(new URL('../std.af', import.meta.url), 'utf8'));
});
