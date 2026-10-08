// Reads `claude -p --output-format stream-json --verbose` line by line and turns it into:
//   { type: 'usage', tokens, model }   tokens spent by one API call since it was last counted
//   { type: 'step', sub, status?, message }   a step marker the skill emitted by running
//                                       `node scripts/factory-step.mjs <sub> [status] ["message"]`
//   { type: 'result', isError, text, model }   the final result event
//
// Token usage: each assistant message carries `usage`; the same message id can appear in
// several events (one per content block, usage growing), so only the growth since the last
// event of that id is counted. Tokens = input + output + cache creation + cache read.

const tokensOf = (u = {}) =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

// Split a shell command's arguments, honouring "double" and 'single' quotes.
function shellWords(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

export function parseStepCommand(command) {
  const at = command.search(/factory-step\.mjs/);
  if (at === -1) return null;
  const words = shellWords(command.slice(at)).slice(1); // drop the script path
  const [sub, maybeStatus, ...rest] = words;
  if (!sub) return null;
  const statuses = ['running', 'blocked', 'succeeded', 'failed'];
  if (maybeStatus && statuses.includes(maybeStatus)) return { sub, status: maybeStatus, message: rest.join(' ') };
  return { sub, status: undefined, message: [maybeStatus, ...rest].filter(Boolean).join(' ') };
}

export function createStreamParser() {
  const counted = new Map(); // message id → tokens already counted
  let lastModel = null;
  return {
    push(line) {
      const events = [];
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return events;
      }
      if (ev.type === 'system' && ev.model) lastModel = ev.model;
      if (ev.type === 'assistant' && ev.message) {
        const msg = ev.message;
        if (msg.model) lastModel = msg.model;
        if (msg.usage) {
          const total = tokensOf(msg.usage);
          const id = msg.id || `anon-${counted.size}`;
          const delta = total - (counted.get(id) || 0);
          if (delta > 0) {
            counted.set(id, total);
            events.push({ type: 'usage', tokens: delta, model: msg.model || lastModel });
          }
        }
        for (const block of msg.content || []) {
          if (block.type === 'tool_use' && /bash/i.test(block.name || '') && typeof block.input?.command === 'string') {
            const step = parseStepCommand(block.input.command);
            if (step) events.push({ type: 'step', ...step });
          }
        }
      }
      if (ev.type === 'result') {
        events.push({ type: 'result', isError: Boolean(ev.is_error) || ev.subtype !== 'success', text: ev.result || '', model: lastModel });
      }
      return events;
    },
  };
}
