import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INBOX_DIR } from '../src/escalation/escalator.js';
import { SESSION_DIR } from '../src/escalation/session.js';

/**
 * Scripted end-to-end demonstration of human handoff.
 *
 * Everything here is the real mechanism: a real shared browser session, the real policy
 * gate raising a real confirmation requirement, the real intervention inbox, and the
 * real operator console HTTP endpoint. The single thing being stood in for is the
 * *person* — the script posts the same form the console's buttons post, after reading
 * the same request an operator would read.
 *
 * Run it with the stand-in portal already up:  npm run app  (in another terminal)
 */
const OPERATOR_PORT = 7788;
const children: ChildProcess[] = [];
const kill = () => children.forEach(c => c.kill());
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(130); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = (args: string[], opts: { inherit?: boolean } = {}) =>
  spawn('npx', ['tsx', ...args], { stdio: opts.inherit ? 'inherit' : 'ignore' });

const heading = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

fs.rmSync(SESSION_DIR, { recursive: true, force: true });

heading('1. starting the shared browser session');
children.push(run(['src/cli/session.ts', '--headless']));
children.push(run(['src/cli/operator.ts']));
for (let i = 0; i < 40 && !fs.existsSync(path.join(SESSION_DIR, 'session.json')); i++) await sleep(250);
await sleep(1000);
console.log('   session up; the browser now outlives any single run');

heading('2. replaying a capability whose final step opens an account');
const replay = spawn('npx', [
  'tsx', 'src/cli/replay.ts',
  '--artifact', 'artifacts/member.open_sub_account.json',
  '--input', 'memberId=12345',
  '--input', 'accountType=Holiday Savings',
  '--input', 'openingDeposit=250.00',
  '--escalation-wait', '120000',
], { stdio: 'inherit' });
children.push(replay);

heading('3. waiting for the run to decide it must not proceed alone');
let request: any = null;
for (let i = 0; i < 80; i++) {
  const files = fs.existsSync(INBOX_DIR) ? fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')) : [];
  if (files.length) { request = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, files[0]!), 'utf8')); break; }
  await sleep(500);
}
if (!request) { console.error('no intervention was raised'); process.exit(1); }

console.log(`   intervention ${request.id}`);
console.log(`   blocked at   ${request.stepId}`);
console.log(`   reason       ${request.reason}`);
console.log(`   live session ${request.session?.cdpEndpoint} (the operator works in this window, not a copy)`);
console.log(`   screenshot   ${request.screenshotPath}`);
console.log(`   lease        ${JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'lease.json'), 'utf8')).holder}`);

heading('4. the operator takes control (same form the console button posts)');
const act = (body: Record<string, string>) =>
  fetch(`http://localhost:${OPERATOR_PORT}/act`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
await act({ id: request.id, do: 'claim' });
await sleep(1500);
console.log(`   lease now held by ${JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'lease.json'), 'utf8')).holder} — automation is blocked, not racing`);

heading('5. the operator authorizes the step once and hands control back');
await act({ id: request.id, do: 'authorize', note: 'supervisor reviewed; approved opening for this member' });
console.log(`   lease returned to ${JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'lease.json'), 'utf8')).holder}`);

const code: number = await new Promise(resolve => replay.on('exit', c => resolve(c ?? 1)));
heading(`6. run finished with exit code ${code} (0 success, 3 business outcome, 4 escalated, 1 failure)`);

const resolved = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, `${request.id}.json`), 'utf8'));
console.log(`   resolution   ${resolved.resolution}`);
console.log(`   authorized   ${resolved.operatorAuthorizedStep}`);
console.log(`   note         ${resolved.operatorNote}`);
kill();
process.exit(code === 0 ? 0 : 1);
