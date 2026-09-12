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
 * MOCKED: the presentation. A production console would stream the session, badge by
 * queue and SLA, authenticate the operator and scope them to a tenant. None of that is
 * here; this is one page and a few buttons.
 *
 * NOT MOCKED: the mechanism underneath it, which is the part the design question is
 * actually about. The request carries real context from the stuck run. "Take control"
 * moves a real lease that the policy gate really enforces, so automation stops acting
 * the moment a person claims the session. The operator works in the *same live browser
 * window* the run was using — the console hands them its CDP endpoint, and the run is
 * blocked, not dead, while they do. "Return control" hands the lease back with a new
 * token and the run resumes by re-proving its precondition, not by assuming.
 *
 * Swapping this page for a co-browsing product changes nothing below it.
 */
const args = parseArgs();
const port = Number(str(args, 'port', '7788'));

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Operator Console</title>
<meta http-equiv="refresh" content="4">
<style>
 body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#14161a;color:#dfe3ea;margin:0;padding:24px}
 h1{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#8b95a7;margin:0 0 18px}
 .card{border:1px solid #2a2f39;border-radius:6px;padding:14px 16px;margin-bottom:14px;background:#181b21}
 .open{border-left:3px solid #e0a03a}.claimed{border-left:3px solid #4a9edd}.resolved{border-left:3px solid #3f9e6a;opacity:.55}
 .k{color:#7a8496;display:inline-block;width:112px}
 .reason{color:#e0a03a;margin:8px 0}
 button{font:inherit;background:#2a2f39;color:#dfe3ea;border:1px solid #3b414d;border-radius:4px;padding:6px 14px;cursor:pointer;margin-right:8px}
 button.primary{background:#2f5d43;border-color:#3f7d5a}
 input[type=text]{font:inherit;background:#0f1115;color:#dfe3ea;border:1px solid #3b414d;border-radius:4px;padding:6px 10px;width:340px}
 label{color:#7a8496}
 img{max-width:560px;border:1px solid #2a2f39;border-radius:4px;margin-top:10px;display:block}
 code{background:#0f1115;padding:2px 6px;border-radius:3px;color:#9fd0b0}
 .lease{font-size:12px;color:#7a8496;margin-bottom:18px}
 .empty{color:#5c6577;padding:30px 0}
</style></head><body>${body}</body></html>`;

const card = (r: InterventionRequest) => {
  const lease = readLease();
  const mine = lease.holder === 'human' && lease.interventionId === r.id;
  return `<div class="card ${r.status}">
    <div><span class="k">intervention</span><b>${r.id}</b> &nbsp; <span style="color:#7a8496">${r.status}</span></div>
    <div><span class="k">capability</span>${r.capabilityId}@${r.capabilityVersion}</div>
    <div><span class="k">tenant</span>${r.tenantId}</div>
    <div><span class="k">blocked at</span>${r.stepId} — ${r.stepIntent}</div>
    <div><span class="k">run</span>${r.runId}</div>
    <div class="reason">▲ ${r.reason}</div>
    <div><span class="k">screen</span>${r.screenSummary}</div>
    ${r.session ? `<div><span class="k">live session</span><code>${r.session.cdpEndpoint}</code> — the browser window this run was using is still open; work in it directly.</div>` : `<div><span class="k">live session</span>no shared session: this run owned its own browser and cannot be handed over. Start <code>npm run session</code> first.</div>`}
    ${r.humanActions?.length ? `<div><span class="k">you did</span>${r.humanActions.map(a => `${a.kind} ${a.detail}`).join(' → ')}</div>` : ''}
    ${r.screenshotPath && fs.existsSync(r.screenshotPath) ? `<img src="/shot?p=${encodeURIComponent(r.screenshotPath)}">` : ''}
    ${r.status === 'resolved' || r.status === 'abandoned' ? '' : `
    <form method="POST" action="/act" style="margin-top:14px">
      <input type="hidden" name="id" value="${r.id}">
      ${mine ? `
        <div style="margin-bottom:10px"><label>what you did &nbsp;</label><input type="text" name="note" placeholder="e.g. supervisor override applied, record now visible"></div>
        <button class="primary" name="do" value="authorize">Authorize this step &amp; resume</button>
        <button name="do" value="return">I did it myself &mdash; resume after this step</button>
        <button name="do" value="abandon">Abandon run</button>
        <div style="color:#5c6577;margin-top:10px">Authorizing grants automation <b>one</b> execution of this step. It is not a standing approval and expires the moment it is used.</div>
      ` : `
        <button class="primary" name="do" value="claim">Take control of the live session</button>
        <button name="do" value="abandon">Abandon run</button>
      `}
    </form>`}
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
        // The lease was already ceded when the run escalated; claiming records who has
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
  const lease = readLease();
  const session = readSession();
  const body = `
    <h1>Operator console</h1>
    <div class="lease">
      session: ${session ? `<code>${session.cdpEndpoint}</code> (shared)` : 'none running — start <code>npm run session</code>'}
      &nbsp;·&nbsp; control held by <b style="color:${lease.holder === 'human' ? '#e0a03a' : '#3f9e6a'}">${lease.holder}</b> since ${lease.since}
      ${lease.note ? `&nbsp;·&nbsp; ${lease.note}` : ''}
    </div>
    ${requests.length ? requests.map(card).join('') : '<div class="empty">No intervention requests. Runs that get stuck will appear here.</div>'}`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html(body));
});

server.listen(port, () => {
  console.log(`operator console  http://localhost:${port}`);
  console.log(`inbox             .session/interventions/`);
});
