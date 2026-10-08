#!/usr/bin/env node
// Step marker for the AI Factory dashboard. The qa-jira-pipeline skill runs it at each step
// boundary; scripts/run-pipeline.mjs sees the call in Claude's output stream and posts the
// step change (with the tokens spent so far) to the dashboard. This script itself only echoes.
//
//   node scripts/factory-step.mjs execute                     plan done, execute starts
//   node scripts/factory-step.mjs verdict                     execute done, verdict starts
//   node scripts/factory-step.mjs execute blocked "reason"    waiting on a person
//   node scripts/factory-step.mjs execute failed "reason"     the step cannot be completed
const [sub, status = 'running', ...rest] = process.argv.slice(2);
console.log(`factory step: ${sub || '?'} ${status}${rest.length ? ` — ${rest.join(' ')}` : ''}`);
