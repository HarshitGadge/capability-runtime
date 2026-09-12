import http from 'node:http';
import { URL } from 'node:url';
import { MEMBERS, TENANTS, SUB_ACCOUNT_TYPES } from './data.js';
import * as V from './render.js';

/**
 * Stand-in member-services portal.
 *
 * Two tenants are served from one codebase at /t/<tenant>/..., because that is the
 * shape of the real problem: many institutions running one vendor product, each with
 * its own skin and wording. The fault-injection endpoint exists so the replay engine's
 * error handling can be demonstrated deterministically instead of described.
 */

const PORT = Number(process.env.PORT ?? 5173);

type FaultKind = 'none' | 'session_timeout' | 'interstitial' | 'slow' | 'permission_denied';

/**
 * Server-side fault state, set by the test harness via POST /__control.
 *
 * `onRoute` pins *where* the fault lands. Without it a fault is consumed by whichever
 * request happens to arrive first — in practice the preflight — and the run never sees
 * it. Pinning it to a route puts the interruption squarely mid-flow, which is the case
 * worth demonstrating.
 */
const faults = { kind: 'none' as FaultKind, remaining: 0, delayMs: 0, onRoute: '/member' };

/** Trivial in-memory sessions. Never a real credential store; the password is ignored. */
const sessions = new Set<string>();
let confirmSeq = 8840;

function armed(kind: FaultKind, route: string): boolean {
  if (faults.kind !== kind || faults.remaining <= 0 || faults.onRoute !== route) return false;
  faults.remaining -= 1;
  return true;
}

const send = (res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
};

const readBody = (req: http.IncomingMessage): Promise<URLSearchParams> =>
  new Promise(resolve => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });

const cookies = (req: http.IncomingMessage): Record<string, string> =>
  Object.fromEntries((req.headers.cookie ?? '').split(';').map(p => p.trim().split('=')).filter(p => p[0]) as [string, string][]);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // --- Test-harness control plane. Not part of the modelled application. ---
  if (url.pathname === '/__control') {
    const b = await readBody(req);
    faults.kind = (b.get('kind') as FaultKind) ?? 'none';
    faults.remaining = Number(b.get('count') ?? 1);
    faults.delayMs = Number(b.get('delayMs') ?? 4000);
    faults.onRoute = b.get('onRoute') || '/member';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...faults }));
  }
  // Reset clears fault state only. Clearing sessions here would sign out every other
  // client of the app — including a discovery run in progress — each time a replay
  // starts or finishes, which is a harness bug indistinguishable from a session-timeout
  // fault. The session_timeout fault drops exactly one session, on its armed route.
  if (url.pathname === '/__reset') {
    faults.kind = 'none'; faults.remaining = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/') {
    return send(res, 200, `<!doctype html><h3>Stand-in portal</h3><ul>${Object.keys(TENANTS).map(t => `<li><a href="/t/${t}/">${TENANTS[t]!.institution} (${t})</a></li>`).join('')}</ul>`);
  }

  // --- Everything below is tenant-scoped: /t/<tenant>/<route> ---
  if (parts[0] !== 't' || !parts[1] || !TENANTS[parts[1]]) return send(res, 404, 'Not found');
  const skin = TENANTS[parts[1]]!;
  const base = `/t/${skin.id}`;
  const route = '/' + parts.slice(2).join('/');
  const sid = cookies(req)['sid'];
  const authed = !!sid && sessions.has(sid);



  // Login is the only unauthenticated surface.
  if (route === '/login' && req.method === 'POST') {
    const id = 's' + Math.random().toString(36).slice(2);
    sessions.add(id);
    return send(res, 302, '', { location: `${base}/`, 'set-cookie': `sid=${id}; Path=/` });
  }
  if (route === '/logout') {
    sessions.delete(sid ?? '');
    return send(res, 302, '', { location: `${base}/login` });
  }
  if (route === '/login') return send(res, 200, V.loginPage(skin, base, url.searchParams.has('expired')));

  // A dropped session is indistinguishable, from the outside, from never having signed
  // on — which is exactly why replay has to detect it by what is on screen.
  if (!authed) {
    const expired = faults.kind === 'session_timeout';
    return send(res, 200, V.loginPage(skin, base, expired));
  }
  if (armed('session_timeout', route)) {
    sessions.delete(sid!);
    return send(res, 200, V.loginPage(skin, base, true));
  }
  if (armed('slow', route)) await sleep(faults.delayMs);

  if (route === '/' || route === '') return send(res, 200, V.shellPage(skin, base));
  if (route === '/nav') return send(res, 200, V.navFrame(skin, base));
  if (route === '/reports') return send(res, 200, V.reportsFrame(skin));

  // Acknowledging returns the operator to the screen the banner interrupted, which is
  // what makes `then: retry_step` the correct recovery policy for it.
  if (route === '/ack') {
    const back = req.headers.referer ?? `${base}/search`;
    return send(res, 302, '', { location: back });
  }

  if (route === '/search' && req.method === 'POST') {
    const id = (await readBody(req)).get('memberId')?.trim() ?? '';
    if (!/^\d+$/.test(id)) return send(res, 200, V.searchFrame(skin, base, { error: 'Member identifier must be numeric.' }));
    const m = MEMBERS[id];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, id));
    if (m.status === 'restricted' || armed('permission_denied', route)) return send(res, 200, V.deniedFrame(skin, base, id));
    return send(res, 200, V.resultsFrame(skin, base, m));
  }
  if (route === '/search') return send(res, 200, V.searchFrame(skin, base, { notice: armed('interstitial', route) }));

  if (route === '/member') {
    const m = MEMBERS[url.searchParams.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, url.searchParams.get('id') ?? ''));
    if (m.status === 'restricted') return send(res, 200, V.deniedFrame(skin, base, m.id));
    return send(res, 200, V.memberFrame(skin, base, m, armed('interstitial', route)));
  }

  if (route === '/transfer' && req.method === 'POST') {
    const b = await readBody(req);
    const m = MEMBERS[b.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, b.get('id') ?? ''));
    const to = (b.get('to') ?? '').trim();
    const amount = Number((b.get('amount') ?? '').replace(/[$,]/g, ''));
    if (!to || !/^\d{6,}$/.test(to)) return send(res, 200, V.transferFrame(skin, base, m, 'Destination account must be a numeric account number.'));
    if (!amount || Number.isNaN(amount) || amount <= 0) return send(res, 200, V.transferFrame(skin, base, m, 'Amount is required and must be positive.'));
    // Insufficient funds is a legitimate business outcome, surfaced on the form.
    if (amount > m.savingsBalance) return send(res, 200, V.transferFrame(skin, base, m, `Insufficient funds: the transfer amount exceeds the available savings balance.`));
    // High-value transfers raise an extra confirmation dialog before review. Like most
    // legacy handlers, the acknowledgement posts back to this same endpoint with a mode
    // flag rather than to a route of its own — so the review screen always lives at
    // /transfer, however it was reached.
    const acknowledged = b.get('ack') === '1';
    return send(res, 200, V.transferReviewFrame(skin, base, m, to, amount, amount >= 1000 && !acknowledged));
  }
  if (route === '/transfer/confirm' && req.method === 'POST') {
    const b = await readBody(req);
    const m = MEMBERS[b.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, b.get('id') ?? ''));
    const to = (b.get('to') ?? '').trim();
    const amount = Number(b.get('amount') ?? 0);
    if (amount > m.savingsBalance) return send(res, 200, V.transferFrame(skin, base, m, 'Insufficient funds: balance changed since review.'));
    return send(res, 200, V.transferDoneFrame(skin, base, m, to, amount, 'TRN-' + ++confirmSeq));
  }
  if (route === '/transfer') {
    const m = MEMBERS[url.searchParams.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, url.searchParams.get('id') ?? ''));
    if (m.status === 'restricted') return send(res, 200, V.deniedFrame(skin, base, m.id));
    return send(res, 200, V.transferFrame(skin, base, m));
  }

  if (route === '/subaccount' && req.method === 'POST') {
    const b = await readBody(req);
    const m = MEMBERS[b.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, b.get('id') ?? ''));
    const type = b.get('type') ?? SUB_ACCOUNT_TYPES[0];
    const deposit = (b.get('deposit') ?? '').trim();
    const amount = Number(deposit.replace(/[$,]/g, ''));
    if (!deposit || Number.isNaN(amount)) return send(res, 200, V.subAccountFrame(skin, base, m, 'Opening deposit is required and must be an amount.'));
    if (amount < 25) return send(res, 200, V.subAccountFrame(skin, base, m, 'Opening deposit must be at least $25.00.'));
    return send(res, 200, V.confirmFrame(skin, base, m, type, '$' + amount.toFixed(2), 'CNF-' + ++confirmSeq));
  }
  if (route === '/subaccount') {
    const m = MEMBERS[url.searchParams.get('id') ?? ''];
    if (!m) return send(res, 200, V.notFoundFrame(skin, base, url.searchParams.get('id') ?? ''));
    return send(res, 200, V.subAccountFrame(skin, base, m));
  }

  return send(res, 404, V.reportsFrame(skin));
});

server.listen(PORT, () => {
  console.log(`stand-in portal on http://localhost:${PORT}`);
  for (const t of Object.values(TENANTS)) console.log(`  ${t.institution.padEnd(24)} http://localhost:${PORT}/t/${t.id}/`);
});
