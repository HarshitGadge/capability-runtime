import { TenantSkin, Member, SUB_ACCOUNT_TYPES } from './data.js';

/**
 * Deliberately hostile markup, in the style of the 2006-era portals this is standing in for:
 *
 *  - nested table layout, no semantic landmarks
 *  - no `id`, no `name` on most controls, no test hooks of any kind
 *  - the member-ID input has NO accessible name: its only label is the text in the
 *    table cell beside it, which is exactly the case that defeats role+name lookup
 *    and forces the proximity-label rung of the locator cascade
 *  - inline onclick handlers rather than real submits
 *  - content lives two frames deep
 *
 * If this looks gratuitous, that is the point: a locator strategy that only works on
 * well-built pages proves nothing about the environment this system targets.
 */

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const money = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function page(skin: TenantSkin, title: string, body: string): string {
  return `<!doctype html><html><head><title>${esc(title)}</title><style>${skin.css}</style></head><body>${body}</body></html>`;
}

export function loginPage(skin: TenantSkin, base: string, expired: boolean): string {
  return page(skin, `${skin.institution} - Sign On`, `
<table width="100%" class="hdr"><tr><td class="pad"><b>${esc(skin.institution)}</b> &nbsp; Member Services Terminal</td></tr></table>
<br>
<center>
<table class="box" cellpadding="0" cellspacing="0"><tr><td class="pad">
  ${expired ? '<table width="100%"><tr><td class="pad" style="background:#ffe0e0;color:#7a0000"><b>Your session has expired.</b> Please sign on again.</td></tr></table><br>' : ''}
  <form method="POST" action="${base}/login">
  <table cellpadding="4">
    <tr><td align="right">Operator ID</td><td><input type="text" name="user" size="20" value="svc.agent"></td></tr>
    <tr><td align="right">Password</td><td><input type="password" name="pass" size="20" value="demo"></td></tr>
    <tr><td></td><td><input type="submit" class="btn" value="Sign On"></td></tr>
  </table>
  </form>
</td></tr></table>
</center>`);
}

/** Two-frame shell. Everything the agent cares about is inside the `content` frame. */
export function shellPage(skin: TenantSkin, base: string): string {
  return `<!doctype html><html><head><title>${esc(skin.institution)} - Member Services</title><style>html,body{margin:0;height:100%}</style></head>
<body>
<table width="100%" height="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td width="180" valign="top"><iframe name="nav"     src="${base}/nav"    width="180" height="100%" frameborder="0" scrolling="no"></iframe></td>
  <td valign="top"><iframe name="content" src="${base}/search" width="100%" height="100%" frameborder="0"></iframe></td>
</tr></table>
</body></html>`;
}

export function navFrame(skin: TenantSkin, base: string): string {
  return page(skin, 'Navigation', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Menu</b></td></tr></table>
<table width="100%" cellpadding="6">
  <tr><td><a href="${base}/search" target="content">${esc(skin.labels.lookupNav)}</a></td></tr>
  <tr><td><a href="${base}/reports" target="content">Reports</a></td></tr>
  <tr><td><a href="${base}/logout" target="_top">Sign Off</a></td></tr>
</table>`);
}

/** The maintenance interstitial. Covers the form, so it must actually be dismissed. */
function interstitial(base: string): string {
  return `
<table width="100%" cellpadding="10" style="background:#fff6d5;border:2px solid #c9a227">
 <tr><td>
   <b>Scheduled Maintenance Notice</b><br>
   Core processing will be unavailable Sunday 02:00-04:00. Acknowledge to continue.<br><br>
   <form method="POST" action="${base}/ack" style="display:inline">
     <input type="hidden" name="back" value="">
     <input type="submit" class="btn" value="Acknowledge">
   </form>
 </td></tr>
</table><br>`;
}

export function searchFrame(skin: TenantSkin, base: string, opts: { notice?: boolean; error?: string }): string {
  return page(skin, skin.labels.lookupNav, `
${opts.notice ? interstitial(base) : ''}
<table width="100%" class="hdr"><tr><td class="pad"><b>${esc(skin.labels.lookupNav)}</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="480"><tr><td class="pad">
${opts.error ? `<table width="100%"><tr><td class="pad" style="background:#ffe0e0;color:#7a0000">${esc(opts.error)}</td></tr></table><br>` : ''}
<form method="POST" action="${base}/search">
<table cellpadding="5">
  <tr>
    <td align="right" nowrap>${esc(skin.labels.memberIdField)}</td>
    <td><input type="text" name="memberId" size="16" maxlength="10"></td>
    <td><input type="submit" class="btn" value="${esc(skin.labels.searchButton)}"></td>
  </tr>
</table>
</form>
<font size="1" color="#666">Enter a numeric member identifier. Partial matches are not supported.</font>
</td></tr></table>`);
}

export function resultsFrame(skin: TenantSkin, base: string, m: Member): string {
  const cells = [
    `<td class="pad">${esc(m.id)}</td>`,
    `<td class="pad">${esc(m.name)}</td>`,
    `<td class="pad">${esc(m.status)}</td>`,
  ];
  if (skin.reverseResultColumns) cells.reverse();
  return page(skin, 'Search Results', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Search Results</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" border="1" width="600">
  <tr>${(skin.reverseResultColumns ? ['Status', 'Member Name', 'Member'] : ['Member', 'Member Name', 'Status']).map(h => `<td class="pad"><b>${h}</b></td>`).join('')}<td class="pad"><b>Action</b></td></tr>
  <tr>${cells.join('')}<td class="pad"><a href="${base}/member?id=${esc(m.id)}">View</a></td></tr>
</table>
<br><a href="${base}/search">New Search</a>`);
}

export function notFoundFrame(skin: TenantSkin, base: string, id: string): string {
  return page(skin, 'Search Results', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Search Results</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="600"><tr><td class="pad">
  <b>No member found</b><br><br>
  No member record matches identifier ${esc(id)}. Verify the number and try again.
</td></tr></table>
<br><a href="${base}/search">New Search</a>`);
}

export function deniedFrame(skin: TenantSkin, base: string, id: string): string {
  return page(skin, 'Access Restricted', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Access Restricted</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="600"><tr><td class="pad" style="color:#7a0000">
  <b>Authorization required</b><br><br>
  Member ${esc(id)} is flagged restricted. A supervisor override is required to view this record.
</td></tr></table>
<br><a href="${base}/search">New Search</a>`);
}

export function memberFrame(skin: TenantSkin, base: string, m: Member, notice = false): string {
  // A banner that merely sits above the content is not an interruption. When armed, the
  // notice replaces the working area entirely — which is what a real maintenance or
  // consent interstitial does, and what makes it worth recovering from.
  if (notice) return page(skin, 'Notice', interstitial(base));
  return page(skin, `Member ${esc(m.id)}`, `
<table width="100%" class="hdr"><tr><td class="pad"><b>Member Detail &mdash; ${esc(m.id)}</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="620"><tr><td class="pad">
<table cellpadding="5" width="100%">
  <tr><td align="right" width="180">Member Name</td><td><b>${esc(m.name)}</b></td></tr>
  <tr><td align="right">Member Since</td><td>${esc(m.joined)}</td></tr>
  <tr><td align="right">Status</td><td>${esc(m.status)}</td></tr>
  <tr><td align="right">Savings Account</td><td>${esc(m.savingsAccount)}</td></tr>
  <tr><td align="right">${esc(skin.labels.savingsBalance)}</td><td><b>${money(m.savingsBalance)}</b></td></tr>
  <tr><td align="right">Checking Account</td><td>${esc(m.checkingAccount)}</td></tr>
</table>
</td></tr></table>
<br>
<a href="${base}/subaccount?id=${esc(m.id)}">${esc(skin.labels.openSubAccount)}</a>
&nbsp;|&nbsp;<a href="${base}/search">New Search</a>`);
}

export function subAccountFrame(skin: TenantSkin, base: string, m: Member, error?: string): string {
  return page(skin, 'Open Sub-Account', `
<table width="100%" class="hdr"><tr><td class="pad"><b>${esc(skin.labels.openSubAccount)} &mdash; ${esc(m.id)}</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="560"><tr><td class="pad">
${error ? `<table width="100%"><tr><td class="pad" style="background:#ffe0e0;color:#7a0000"><b>Validation error:</b> ${esc(error)}</td></tr></table><br>` : ''}
<form method="POST" action="${base}/subaccount">
<input type="hidden" name="id" value="${esc(m.id)}">
<table cellpadding="5">
  <tr><td align="right">Account Type</td><td>
    <select name="type">${SUB_ACCOUNT_TYPES.map(t => `<option>${t}</option>`).join('')}</select></td></tr>
  <tr><td align="right" nowrap>Opening Deposit</td><td><input type="text" name="deposit" size="12"></td></tr>
  <tr><td align="right">Nickname</td><td><input type="text" name="nickname" size="24"></td></tr>
  <tr><td colspan="2"><hr></td></tr>
  <tr><td></td><td><input type="submit" class="btn" value="Open Account"></td></tr>
</table>
</form>
<font size="1" color="#666">Opening deposit must be at least $25.00. This action cannot be undone.</font>
</td></tr></table>`);
}

export function confirmFrame(skin: TenantSkin, base: string, m: Member, type: string, deposit: string, ref: string): string {
  return page(skin, 'Sub-Account Opened', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Confirmation</b></td></tr></table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="560"><tr><td class="pad">
  <b>Sub-account opened successfully.</b><br><br>
  <table cellpadding="5">
    <tr><td align="right" width="160">Confirmation Number</td><td><b>${esc(ref)}</b></td></tr>
    <tr><td align="right">Member</td><td>${esc(m.id)} &mdash; ${esc(m.name)}</td></tr>
    <tr><td align="right">Account Type</td><td>${esc(type)}</td></tr>
    <tr><td align="right">Opening Deposit</td><td>${esc(deposit)}</td></tr>
  </table>
</td></tr></table>
<br><a href="${base}/member?id=${esc(m.id)}">Back to Member</a>`);
}

export function reportsFrame(skin: TenantSkin): string {
  return page(skin, 'Reports', `
<table width="100%" class="hdr"><tr><td class="pad"><b>Reports</b></td></tr></table>
<br><table class="box" cellpadding="0" cellspacing="0" width="480"><tr><td class="pad">
No scheduled reports are available for this operator.</td></tr></table>`);
}
