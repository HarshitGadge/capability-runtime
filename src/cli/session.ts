import { startSession } from '../escalation/session.js';
import { claimForAutomation } from '../escalation/lease.js';
import { parseArgs, flag, str } from './common.js';

/**
 * Start the shared, long-lived browser session and hold it open.
 *
 * Run this in its own terminal when you want to exercise human handoff: it is the
 * process that owns the window, so automation runs can come and go — and get stuck,
 * and be taken over by a person — without the session ever dying.
 */
const args = parseArgs();
const headless = flag(args, 'headless');
const port = Number(str(args, 'port', '9222'));

const { info } = await startSession({ headless, port });
claimForAutomation();

console.log(`shared browser session up`);
console.log(`  cdp endpoint   ${info.cdpEndpoint}`);
console.log(`  headless       ${info.headless}`);
console.log(`  lease          .session/lease.json`);
console.log(`\nleave this running. ctrl-c to tear the session down.`);

process.on('SIGINT', () => { console.log('\nsession closed'); process.exit(0); });
await new Promise(() => {});
