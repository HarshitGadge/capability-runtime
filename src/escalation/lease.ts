import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_DIR } from './session.js';

const LEASE_FILE = path.join(SESSION_DIR, 'lease.json');

export type Holder = 'automation' | 'human';

export interface Lease {
  holder: Holder;
  /** Whoever holds this token may act. Presented on release to prevent a stale runner resuming. */
  token: string;
  since: string;
  /** Set while a human holds control, so the runner knows which request it is blocked on. */
  interventionId?: string;
  note?: string;
}

/**
 * Single-writer control lease over the live session.
 *
 * "Who is in control" has to be an explicit, externally visible fact, not an implicit
 * consequence of which process happens to be running. Two things follow. The runner
 * checks the lease before *every* action, so a human who takes over mid-step is not
 * fighting an automation that is still clicking. And control returns with a new token,
 * so a runner that was killed and restarted cannot resurrect itself into a session a
 * person is now using.
 *
 * A file is the right size for this. It is inspectable with `cat`, survives process
 * death, and needs no daemon. A fleet would put the same three fields in a row in a
 * database with a TTL; nothing above this module would change.
 */
export function readLease(): Lease {
  try {
    return JSON.parse(fs.readFileSync(LEASE_FILE, 'utf8'));
  } catch {
    return { holder: 'automation', token: 'bootstrap', since: new Date().toISOString() };
  }
}

function write(lease: Lease): Lease {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(LEASE_FILE, JSON.stringify(lease, null, 2));
  return lease;
}

export const claimForAutomation = (): Lease =>
  write({ holder: 'automation', token: crypto.randomUUID(), since: new Date().toISOString() });

/** Automation pauses and offers the session to a person. */
export const cedeToHuman = (interventionId: string, note: string): Lease =>
  write({ holder: 'human', token: crypto.randomUUID(), since: new Date().toISOString(), interventionId, note });

/** The operator hands the session back; automation must re-observe before trusting it. */
export const returnToAutomation = (note?: string): Lease =>
  write({ holder: 'automation', token: crypto.randomUUID(), since: new Date().toISOString(), note });

export const automationMayAct = (): boolean => readLease().holder === 'automation';

/** Block until the human releases, or give up. Returns false on timeout. */
export async function waitForAutomationControl(timeoutMs: number, pollMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (automationMayAct()) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}
