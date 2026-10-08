// Stands in for `claude -p … --output-format stream-json --verbose` in tests. Emits a realistic
// stream: an init event, assistant messages with usage (one message split over two events with
// growing usage, a model switch), the skill's factory-step markers as Bash tool calls, and a
// final result. FAKE_CLAUDE_EXIT sets the exit code; FAKE_CLAUDE_HANG=1 never exits.
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = (i, o, cc = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const bash = (command) => ({ type: 'tool_use', id: `tu_${Math.random()}`, name: 'Bash', input: { command } });
const SONNET = 'claude-sonnet-4-5';
const HAIKU = 'claude-haiku-4-5';

out({ type: 'system', subtype: 'init', model: SONNET });
// plan: one message reported twice (usage grows: 100+10 → 100+40), then a second message
out({ type: 'assistant', message: { id: 'm1', model: SONNET, content: [{ type: 'text', text: 'Reading the ticket' }], usage: usage(100, 10) } });
out({ type: 'assistant', message: { id: 'm1', model: SONNET, content: [{ type: 'text', text: 'Reading the ticket…' }], usage: usage(100, 40) } });
out({ type: 'assistant', message: { id: 'm2', model: SONNET, content: [bash('node scripts/factory-step.mjs execute')], usage: usage(200, 20, 30, 50) } });
// execute: a model switch inside the step
out({ type: 'assistant', message: { id: 'm3', model: SONNET, content: [{ type: 'text', text: 'Running TC_01' }], usage: usage(300, 60) } });
out({ type: 'assistant', message: { id: 'm4', model: HAIKU, content: [{ type: 'text', text: 'Checking record' }], usage: usage(50, 5) } });
out({ type: 'assistant', message: { id: 'm5', model: HAIKU, content: [bash('cd x && node scripts/factory-step.mjs verdict')], usage: usage(70, 7) } });
// verdict
out({ type: 'assistant', message: { id: 'm6', model: SONNET, content: [{ type: 'text', text: 'Filing bugs' }], usage: usage(400, 80) } });
if (process.env.FAKE_CLAUDE_HANG === '1') setInterval(() => {}, 1000);
else {
  out({ type: 'result', subtype: 'success', is_error: false, result: 'EXEC-0001 done' });
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
}
