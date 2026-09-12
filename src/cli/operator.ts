import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Escalator, type InterventionRequest } from '../escalation/escalator.js';
import { readLease, returnToAutomation, cedeToHuman } from '../escalation/lease.js';
import { readSession } from '../escalation/session.js';
import { parseArgs, str } from './common.js';

/**
 * Operator console — deliberately minimal, deliberately real.
 *
 * MOCKED: the presentation. A production console would stream the session live, badge by
 * queue and SLA, authenticate the operator and scope them to a tenant. This is one page.
 *
 * NOT MOCKED: the mechanism, which is the part the design question is about. "Take
 * control" moves a real lease the policy gate enforces, so automation stops acting the
 * moment a person claims it. The operator works in the *same live browser window* the run
 * was using — the console hands them its CDP endpoint — and the run is blocked, not dead,
 * while they do. "Return control" hands the lease back with a new token and the run
 * resumes by re-proving its precondition. Swapping this page for a co-browsing product
 * changes nothing beneath it.
 *
 * The page is styled only so a reviewer opening it cold can see the control-transfer in a
 * few seconds — the legibility is the point, not decoration.
 */
const args = parseArgs();
const port = Number(str(args, 'port', '7788'));

const esc = (s: string) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

const STYLE = `
 :root{--bg:#0f1216;--panel:#161a20;--line:#262c36;--dim:#7a8496;--fg:#e7ebf1;--amber:#e0a03a;--green:#4bbe82;--blue:#4a9edd;--red:#e0685f}
 *{box-sizing:border-box}
 body{font:13.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg);margin:0;padding:0}
 .wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
 header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px}
 h1{font-size:16px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:0}
 .sub{color:var(--dim);font-size:12px;margin:0 0 20px}
 .pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-weight:600;font-size:13px}
 .pill.automation{background:rgba(75,190,130,.12);color:var(--green);border:1px solid rgba(75,190,130,.4)}
 .pill.human{background:rgba(224,160,58,.14);color:var(--amber);border:1px solid rgba(224,160,58,.5)}
 .pill .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
 .bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-bottom:14px}
 .bar .meta{color:var(--dim);font-size:12px}
 details{border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-bottom:20px}
 summary{cursor:pointer;padding:12px 16px;color:var(--dim);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
 .legend{padding:0 18px 16px;color:var(--dim);font-size:12.5px}
 .legend ol{margin:8px 0 0;padding-left:20px}.legend li{margin:5px 0}
 .card{border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-bottom:16px;overflow:hidden}
 .card.open{border-left:3px solid var(--amber)}
 .card.claimed{border-left:3px solid var(--blue)}
 .card.resolved,.card.abandoned{opacity:.5}
 .chead{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line)}
 .chip{font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:3px 9px;border-radius:5px;font-weight:600}
 .chip.open{background:rgba(224,160,58,.14);color:var(--amber)}
 .chip.claimed{background:rgba(74,158,221,.14);color:var(--blue)}
 .chip.resolved{background:rgba(75,190,130,.14);color:var(--green)}
 .chip.abandoned{background:rgba(224,104,95,.14);color:var(--red)}
 .cbody{padding:14px 16px;display:grid;grid-template-columns:120px 1fr;gap:6px 14px;align-items:start}
 .cbody .k{color:var(--dim)}
 .cbody .v{color:var(--fg);word-break:break-word}
 .blocked{color:var(--amber)}
 .reason{grid-column:1/-1;margin:8px 0 2px;padding:10px 12px;border-radius:6px;background:rgba(224,160,58,.08);border:1px solid rgba(224,160,58,.3);color:var(--amber)}
 .did{grid-column:1/-1;color:var(--blue);font-size:12.5px}
 code{background:#0b0e12;padding:2px 7px;border-radius:4px;color:#9fd0b0;font-size:12.5px}
 figure{grid-column:1/-1;margin:10px 0 0}
 figure figcaption{color:var(--dim);font-size:11.5px;margin-bottom:6px}
 img{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}
 form{grid-column:1/-1;margin-top:8px;border-top:1px dashed var(--line);padding-top:14px}
 .hint{color:var(--dim);font-size:12px;margin:4px 0 12px}
 input[type=text]{font:inherit;background:#0b0e12;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 11px;width:100%;max-width:420px;margin-bottom:12px}
 button{font:inherit;background:#232935;color:var(--fg);border:1px solid #313847;border-radius:6px;padding:8px 15px;cursor:pointer;margin:0 8px 8px 0}
 button.primary{background:#215b3f;border-color:#2f7d56;color:#eafff2}
 button.danger{background:#3a2320;border-color:#5a2f2b;color:#f0b6b0}
 .note{color:var(--dim);font-size:12px;margin-top:4px}
 .empty{color:#5c6577;padding:40px 4px;text-align:center}
`;

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Operator Console</title>` +
  `<meta http-equiv="refresh" content="4"><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;

const legend = `
<details>
 <summary>How a handoff works</summary>
 <div class="legend">
  A capability replays with no model in the loop. When it hits a step it must not take alone —
  an irreversible action, an ambiguity it will not guess, a recovery it has exhausted — it does this:
  <ol>
   <li><b>Escalates</b> and <b>cedes the session</b>: the control lease flips to <span style="color:var(--amber)">human</span>, and the policy gate refuses every automation action while it is held.</li>
   <li>Files the request below with the blocked step, why it stopped, a screenshot, and the CDP endpoint of the <b>live</b> browser the run was using.</li>
   <li>You <b>take control</b> and work in that same window, then either <b>authorize the step once</b> or say you did it yourself.</li>
   <li>Control returns with a new token; the run <b>re-proves the step's precondition</b> and resumes — it does not assume the screen is where you left it.</li>
  </ol>
 </div>
</details>`;

const row = (k: string, v: string, cls = 'v') => `<div class="k">${k}</div><div class="${cls}">${v}</div>`;

const card = (r: InterventionRequest) => {
  const lease = readLease();
  const mine = lease.holder === 'human' && lease.interventionId === r.id;
  const live = r.session
    ? `<code>${esc(r.session.cdpEndpoint)}</code> — the browser window this run was using is still open; work in it directly.`
    : `no shared session: this run owned its own browser and cannot be handed over. Start <code>npm run session</code> first.`;
  const shot = r.screenshotPath && fs.existsSync(r.screenshotPath)
    ? `<figure><figcaption>what the run saw when it stopped (redacted)</figcaption><img src="/shot?p=${encodeURIComponent(r.screenshotPath)}"></figure>` : '';
  const did = r.humanActions?.length
    ? `<div class="did">you did: ${esc(r.humanActions.map(a => `${a.kind} ${a.detail}`).join(' → '))}</div>` : '';

  const controls = (r.status === 'resolved' || r.status === 'abandoned') ? '' : `
    <form method="POST" action="/act">
      <input type="hidden" name="id" value="${esc(r.id)}">
      ${mine ? `
        <div class="hint">You hold this session. Complete the step in the live window, or authorize automation to take it once.</div>
        <input type="text" name="note" placeholder="what you did — e.g. supervisor override applied, record now visible">
        <div>
          <button class="primary" name="do" value="authorize">Authorize this step &amp; resume</button>
          <button name="do" value="return">I did it myself &mdash; resume after this step</button>
          <button class="danger" name="do" value="abandon">Abandon run</button>
        </div>
        <div class="note">Authorizing grants automation <b>one</b> execution of this step — not a standing approval; it expires the moment it is used.</div>
      ` : `
        <div class="hint">Claim the lease to work in the run's live session. Automation is already paused.</div>
        <div>
          <button class="primary" name="do" value="claim">Take control of the live session</button>
          <button class="danger" name="do" value="abandon">Abandon run</button>
        </div>
      `}
    </form>`;

  return `<div class="card ${r.status}">
    <div class="chead"><b>${esc(r.id)}</b><span class="chip ${r.status}">${r.status}</span></div>
    <div class="cbody">
      ${row('capability', `${esc(r.capabilityId)}@${esc(r.capabilityVersion)}`)}
      ${row('tenant', esc(r.tenantId))}
      ${row('run', esc(r.runId))}
      ${row('blocked at', `<span class="blocked">${esc(r.stepId)}</span> — ${esc(r.stepIntent)}`)}
      <div class="reason">&#9650; ${esc(r.reason)}</div>
      ${row('on screen', esc(r.screenSummary))}
      ${row('live session', live)}
      ${did}
      ${shot}
      ${controls}
    </div>
  </div>`;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/shot') {
    const p = url.searchParams.get('p') ?? '';
    if (!fs.existsSync(p) || !path.resolve(p).startsWith(process.cwd())) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(fs.readFileSync(p));
  }

  if (url.pathname === '/act' && req.method === 'POST') {
    let raw = ''; req.on('data', c => (raw += c));
    await new Promise(r => req.on('end', r));
    const body = new URLSearchParams(raw);
    const id = body.get('id')!;
    const action = body.get('do');
    const request = Escalator.read(id);

    if (request) {
      if (action === 'claim') {
        // The lease was already ceded when the run escalated; claiming records who holds
        // it and keeps automation blocked while they work.
        cedeToHuman(id, `operator working ${id}`);
        request.status = 'claimed';
      } else if (action === 'authorize' || action === 'return') {
        request.status = 'resolved';
        request.resolution = 'resumed';
        request.operatorNote = body.get('note') ?? undefined;
        request.operatorAuthorizedStep = action === 'authorize';
        request.operatorDidStep = action === 'return';
        returnToAutomation(`operator ${action === 'authorize' ? 'authorized' : 'completed'} ${id}`);
      } else if (action === 'abandon') {
        request.status = 'abandoned';
        request.resolution = 'abandoned';
        request.operatorNote = body.get('note') ?? undefined;
        returnToAutomation(`operator abandoned ${id}`);
      }
      Escalator.write(request);
    }
    res.writeHead(302, { location: '/' });
    return res.end();
  }

  const requests = Escalator.list();
  const open = requests.filter(r => r.status === 'open' || r.status === 'claimed');
  const lease = readLease();
  const session = readSession();
  const holder = lease.holder;

  const body = `
    <header>
      <h1>Operator console</h1>
      <span class="pill ${holder}"><span class="dot"></span>${holder === 'human' ? 'human in control' : 'automation in control'}</span>
    </header>
    <p class="sub">Human-in-the-loop handoff for capabilities that cannot safely finish on their own.</p>
    <div class="bar">
      <div>shared session: ${session ? `<code>${esc(session.cdpEndpoint)}</code>` : '<span class="meta">none — start <code>npm run session</code></span>'}</div>
      <div class="meta">${open.length} open &middot; control since ${esc(lease.since.replace('T', ' ').slice(0, 19))}${lease.note ? ` &middot; ${esc(lease.note)}` : ''}</div>
    </div>
    ${legend}
    ${requests.length ? requests.map(card).join('') : '<div class="empty">No intervention requests yet.<br>Run a capability that hits a step it must not take alone, and it appears here.</div>'}`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(body));
});

server.listen(port, () => {
  console.log(`operator console  http://localhost:${port}`);
  console.log(`inbox             .session/interventions/`);
});
