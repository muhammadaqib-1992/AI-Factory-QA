// When may the pipeline close a parent ticket? (scripts/close-completed.mjs → decideClosure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideClosure } from '../scripts/close-completed.mjs';

const CLOSED = 'Done / Closed';
const run = (cases, complete = true) => ({ complete, testCases: cases });

test('all passed, no bugs → close', () => {
  assert.equal(decideClosure(run([{ status: 'Passed' }, { status: 'Passed' }]), {}, CLOSED).close, true);
});

test('failed case whose bug is closed → close', () => {
  const r = run([{ status: 'Passed' }, { status: 'Failed', bugs: ['NU-2'] }]);
  assert.equal(decideClosure(r, { 'NU-2': 'Done / Closed' }, CLOSED).close, true);
});

test('bug still open or reopened → stay open', () => {
  const r = run([{ status: 'Failed', bugs: ['NU-2', 'NU-3'] }]);
  const d = decideClosure(r, { 'NU-2': 'Done / Closed', 'NU-3': 'Reopen' }, CLOSED);
  assert.equal(d.close, false);
  assert.match(d.reason, /NU-3 \(Reopen\)/);
});

test('blocked case, failure without a bug, or incomplete run → stay open', () => {
  assert.equal(decideClosure(run([{ status: 'Passed' }, { status: 'Blocked' }]), {}, CLOSED).close, false);
  assert.equal(decideClosure(run([{ status: 'Failed' }]), {}, CLOSED).close, false);
  assert.equal(decideClosure(run([{ status: 'Passed' }], false), {}, CLOSED).close, false);
  assert.equal(decideClosure(null, {}, CLOSED).close, false);
});

test('a bug filed during a retest must close too', () => {
  const r = run([{ status: 'Failed', bugs: ['NU-2'] }]);
  assert.equal(decideClosure(r, { 'NU-2': 'Done / Closed', 'NU-9': 'Open' }, CLOSED, ['NU-2', 'NU-9']).close, false);
  assert.equal(decideClosure(r, { 'NU-2': 'Done / Closed', 'NU-9': 'Done / Closed' }, CLOSED, ['NU-2', 'NU-9']).close, true);
});

test('status names compare case-insensitively', () => {
  const r = run([{ status: 'Failed', bugs: ['NU-2'] }]);
  assert.equal(decideClosure(r, { 'NU-2': 'done / closed' }, CLOSED).close, true);
});
