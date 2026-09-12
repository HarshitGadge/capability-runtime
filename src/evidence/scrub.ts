import fs from 'node:fs';
import path from 'node:path';

/**
 * Retroactive, declaration-driven scrub of a discovery run's evidence.
 *
 * During discovery the pattern redactor catches values that look like account numbers
 * or balances. It cannot catch a surname or a confirmation reference — nothing about
 * "J. Whitfield" says "regulated". But by the end of the run the *artifact* says so: the
 * model declared `member_name` regulated and the runtime read its value off a known
 * element. That is a better signal than any regex, and the run's transcript, recording
 * and log are rewritten with it before the run is reported complete.
 *
 * The replacement is one stable token per output, applied identically to every file, so
 * a recording scrubbed this way still recompiles: the compiler compares element text to
 * observation text, and both now carry the same token.
 */
export function scrubDeclaredValues(
  dir: string,
  values: Array<{ name: string; value: string }>,
  /** Caller-supplied examples: parameters, not extracted data, and needed to recompile. */
  keep: string[] = [],
): { files: string[]; replacements: number } {
  // A regulated value's parts are regulated too. "12345 — J. Whitfield" is one extracted
  // output, but the surname appears on its own on three other screens the model saw.
  const targets = values.flatMap(v => {
    const parts = v.value.split(/\s+[—–|\-]\s+|,\s+|\s+\/\s+/).map(p => p.trim());
    return [v.value, ...parts]
      .filter(x => x.length >= 3 && !keep.includes(x) && !/^\d+$/.test(x))
      .map(value => ({ name: v.name, value }));
  }).sort((a, b) => b.value.length - a.value.length);
  const files = ['transcript.json', 'recording.json', 'run.jsonl']
    .map(f => path.join(dir, f))
    .filter(f => fs.existsSync(f));
  let replacements = 0;
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    for (const { name, value } of targets) {
      const token = `«withheld:${name}»`;
      // Values appear both raw and JSON-escaped (inside the transcript's tool_result
      // strings); replace the escaped form too so nothing survives in a nested string.
      for (const needle of new Set([value, JSON.stringify(value).slice(1, -1)])) {
        const before = text.length;
        text = text.split(needle).join(token);
        replacements += (before - text.length) > 0 || text.includes(token) ? text.split(token).length - 1 : 0;
      }
    }
    fs.writeFileSync(file, text);
  }
  return { files: files.map(f => path.relative(process.cwd(), f)), replacements };
}

/**
 * Find regulated values by where they were shown, not only by what was extracted.
 *
 * The recorded flow extracted one confirmation number, but the model saw a different
 * one while exploring, and it saw the member's name on three screens before it ever
 * pointed at the cell. The artifact knows those outputs by *label* — the rendered screen
 * says `cell "CNF-8848" label="Confirmation Number"` — so every value that ever appeared
 * under a regulated output's label is collected from the transcript and scrubbed
 * wherever it occurs, including inside row text.
 */
export function collectValuesByLabel(dir: string, outputs: Array<{ name: string; label: string }>): Array<{ name: string; value: string }> {
  const transcript = path.join(dir, 'transcript.json');
  if (!fs.existsSync(transcript)) return [];
  const text = fs.readFileSync(transcript, 'utf8');
  const found: Array<{ name: string; value: string }> = [];
  for (const { name, label } of outputs) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Anchor the closing quote: `label="Member"` must not match `label="Member Name"`.
    const re = new RegExp(`cell\\s+\\\\"([^\\\\]+?)\\\\"\\s+label=\\\\"${esc}\\\\"`, 'g');
    for (const m of text.matchAll(re)) {
      const value = m[1]!.replace(/…$/, '').trim();
      if (value && !value.startsWith('«')) found.push({ name, value });
    }
  }
  return found;
}
