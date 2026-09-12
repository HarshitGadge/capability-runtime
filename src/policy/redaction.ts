import crypto from 'node:crypto';

export type Channel = 'llm' | 'evidence' | 'artifact';

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Which outbound channels this rule applies to. Defaults to all three. */
  channels?: Channel[];
}

/**
 * Default rules for the regulated-financial setting.
 *
 * `currency` is thresholded rather than blanket: instructional copy like "minimum
 * $25.00" is not member data, while a four-figure balance is. The threshold is a
 * configuration choice, not a law, and it is stated here so a reviewer can argue with
 * it instead of discovering it.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  { name: 'ssn',      pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'account',  pattern: /\b\d{8,19}\b/g },
  { name: 'currency', pattern: /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{4,}(?:\.\d{2})?/g },
  { name: 'email',    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g },
  { name: 'phone',    pattern: /\b(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g },
];

/**
 * Tokenizing redactor.
 *
 * Two design points that matter more than the regexes:
 *
 * 1. Redaction happens on the *read* path, before an observation reaches the model —
 *    not only on the write path before it reaches disk. A system that shows the model
 *    a member's balance and then scrubs the log has still disclosed the balance to a
 *    third party. The model here never sees one; it locates the cell labelled "Savings
 *    Balance" and the runtime reads it.
 *
 * 2. Tokens are stable within a run and reversible *in process only*. The same value
 *    always yields the same token, so the model can still reason about and refer to a
 *    value it cannot read, and the runtime can return the real value to the caller.
 *    The mapping lives in memory, is never written anywhere, and dies with the process.
 */
export class Redactor {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();

  constructor(private readonly rules: RedactionRule[] = DEFAULT_RULES) {}

  private token(kind: string, value: string): string {
    const existing = this.forward.get(value);
    if (existing) return existing;
    const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 6);
    const token = `«${kind}:${digest}»`;
    this.forward.set(value, token);
    this.reverse.set(token, value);
    return token;
  }

  redact(text: string | undefined, channel: Channel = 'evidence'): string {
    if (!text) return text ?? '';
    let out = text;
    for (const rule of this.rules) {
      if (rule.channels && !rule.channels.includes(channel)) continue;
      out = out.replace(rule.pattern, m => this.token(rule.name, m));
    }
    return out;
  }

  /** Recursively redact an object graph for evidence or artifact serialization. */
  redactDeep<T>(value: T, channel: Channel = 'evidence'): T {
    if (typeof value === 'string') return this.redact(value, channel) as unknown as T;
    if (Array.isArray(value)) return value.map(v => this.redactDeep(v, channel)) as unknown as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, this.redactDeep(v, channel)])) as unknown as T;
    }
    return value;
  }

  /** In-process only. Used to hand real values back to the caller and to type a token the model echoed. */
  reveal(text: string): string {
    let out = text;
    for (const [token, value] of this.reverse) out = out.split(token).join(value);
    return out;
  }

  containsToken(text: string): boolean { return /«\w+:[0-9a-f]{6}»/.test(text); }
}
