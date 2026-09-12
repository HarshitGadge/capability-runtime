/**
 * Fixture data for the stand-in portal. Entirely synthetic: no real members, no real
 * balances, no real credentials. The account numbers below are deliberately shaped
 * like the regulated values the redactor is meant to catch, so the redaction path is
 * exercised by the demo rather than only by unit tests.
 */
export interface Member {
  id: string;
  name: string;
  savingsAccount: string;
  savingsBalance: number;
  checkingAccount: string;
  status: 'active' | 'restricted' | 'dormant';
  joined: string;
}

export const MEMBERS: Record<string, Member> = {
  '10001': { id: '10001', name: 'A. Rivera',    savingsAccount: '4718293046', savingsBalance: 4182.55,  checkingAccount: '4718293047', status: 'active',     joined: '2019-03-11' },
  '10002': { id: '10002', name: 'M. Okonkwo',   savingsAccount: '4718301182', savingsBalance: 916.20,   checkingAccount: '4718301183', status: 'active',     joined: '2021-07-02' },
  '12345': { id: '12345', name: 'J. Whitfield', savingsAccount: '4718355901', savingsBalance: 18204.37, checkingAccount: '4718355902', status: 'active',     joined: '2016-01-28' },
  '20488': { id: '20488', name: 'S. Delacroix', savingsAccount: '4718366120', savingsBalance: 251.09,   checkingAccount: '4718366121', status: 'dormant',    joined: '2013-11-05' },
  '55501': { id: '55501', name: 'R. Castellan', savingsAccount: '4718377338', savingsBalance: 76310.00, checkingAccount: '4718377339', status: 'restricted', joined: '2010-05-19' },
};

export const SUB_ACCOUNT_TYPES = ['Holiday Savings', 'Vacation Club', 'Emergency Fund'] as const;

/** Tenant skins over one vendor product. Same flows, different chrome and wording. */
export interface TenantSkin {
  id: string;
  institution: string;
  /** Wording differences are the interesting part: they are what breaks naive locators. */
  labels: {
    memberIdField: string;
    searchButton: string;
    lookupNav: string;
    savingsBalance: string;
    openSubAccount: string;
  };
  css: string;
  /** tenant-b renders result columns in a different order, to prove ordinal locators are fragile. */
  reverseResultColumns: boolean;
}

const BASE_CSS = `
  /* Presentation only. Everything that makes this surface hostile to automation — frames,
     table layout, no ids or test hooks, labels by adjacency — lives in the markup, which
     this stylesheet never touches. A locator strategy that survives here survives a
     re-skin, and that is the property being demonstrated, not the colour of the buttons. */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  table { border-collapse: collapse; }
  .pad { padding: 10px 14px; }
  .hdr { font-size: 15px; letter-spacing: .01em; }
  .hdr td { padding: 12px 18px; }
  .box { border-radius: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.06); margin: 6px 14px; }
  .box .pad { padding: 18px 20px; }
  .box table td { padding: 8px 10px; vertical-align: middle; }
  .box table td[align="right"] { font-weight: 500; opacity: .75; white-space: nowrap; padding-right: 16px; }
  input[type="text"], input[type="password"], select {
    font: inherit; padding: 8px 11px; border-radius: 7px; border: 1px solid var(--line); background: var(--field); color: inherit;
    transition: border-color .15s, box-shadow .15s; min-width: 220px;
  }
  input[type="text"]:focus, input[type="password"]:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
  input[type="text"]:hover, input[type="password"]:hover, select:hover { border-color: var(--accent); }
  .btn { font: inherit; font-weight: 600; padding: 8px 18px; border-radius: 7px; border: 1px solid transparent; cursor: pointer;
    background: var(--accent); color: var(--on-accent); transition: transform .06s, filter .15s, box-shadow .15s; }
  .btn:hover { filter: brightness(1.08); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
  a { color: var(--accent); text-decoration: none; font-weight: 500; border-bottom: 1px solid transparent; transition: border-color .15s; }
  a:hover { border-bottom-color: currentColor; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0; }
  font[size="1"] { display: block; margin-top: 12px; font-size: 12px; opacity: .65; }
  b { font-weight: 600; }
  /* results / detail tables rendered with border=1 */
  table[border="1"] { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  table[border="1"] td { border: 0; border-bottom: 1px solid var(--line); padding: 10px 14px; }
  table[border="1"] tr:first-child td { background: var(--thead); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .8; }
  table[border="1"] tr:not(:first-child):hover td { background: var(--rowhover); }
  table[border="1"] tr:last-child td { border-bottom: 0; }
  /* inline error / notice boxes the markup paints with legacy inline styles */
  td[style*="background:#ffe0e0"] { border-radius: 7px; border: 1px solid #e6a5a5 !important; }
  table[style*="background:#fff6d5"] { border-radius: 10px; margin: 6px 14px 14px; box-shadow: 0 6px 20px rgba(0,0,0,.08); }
  center > .box { margin-top: 48px; }
`;

export const TENANTS: Record<string, TenantSkin> = {
  'tenant-a': {
    id: 'tenant-a',
    institution: 'Northgate Credit Union',
    labels: {
      memberIdField: 'Member ID',
      searchButton: 'Search',
      lookupNav: 'Member Lookup',
      savingsBalance: 'Savings Balance',
      openSubAccount: 'Open Sub-Account',
    },
    css: BASE_CSS + `
      :root { --accent:#0b3d63; --on-accent:#fff; --ring:rgba(11,61,99,.22); --line:#dfe3e8; --field:#fff; --thead:#f1f4f7; --rowhover:#f6f9fc; }
      body { background:#f5f6f8; color:#1c2330; }
      .hdr { background:#0b3d63; color:#fff; }
      .box { border:1px solid var(--line); background:#fff; }
      /* the navigation frame */
      table[width="100%"][cellpadding="6"] td { padding: 0; }
      table[width="100%"][cellpadding="6"] a { display:block; padding:10px 14px; border-left:3px solid transparent; border-bottom:0; }
      table[width="100%"][cellpadding="6"] a:hover { background:#e9eef4; border-left-color:#0b3d63; }
    `,
    reverseResultColumns: false,
  },
  'tenant-b': {
    id: 'tenant-b',
    institution: 'Vale Mutual Savings',
    labels: {
      memberIdField: 'Member Number',
      searchButton: 'Find Member',
      lookupNav: 'Find a Member',
      savingsBalance: 'Savings Balance',
      openSubAccount: 'Open Sub-Account',
    },
    css: BASE_CSS + `
      :root { --accent:#f2c14e; --on-accent:#2a1633; --ring:rgba(242,193,78,.28); --line:#463a52; --field:#2a2233; --thead:#352b40; --rowhover:#3a2f46; }
      body { background:#1e1826; color:#ece7f2; }
      .hdr { background:#5e2668; color:#ffe9a8; }
      .box { border:1px solid var(--line); background:#2a2233; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
      td[style*="background:#ffe0e0"] { background:#4a2323 !important; color:#ffb3ad !important; border-color:#7a3a3a !important; }
      table[style*="background:#fff6d5"] { background:#3d3320 !important; color:#ffe9a8; border-color:#a67c1b !important; }
      table[width="100%"][cellpadding="6"] td { padding: 0; }
      table[width="100%"][cellpadding="6"] a { display:block; padding:10px 14px; border-left:3px solid transparent; border-bottom:0; }
      table[width="100%"][cellpadding="6"] a:hover { background:#352b40; border-left-color:#f2c14e; }
    `,
    reverseResultColumns: true,
  },
};
