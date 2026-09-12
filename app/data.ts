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
  body { margin:0; font-family: Verdana, Geneva, sans-serif; font-size: 12px; }
  table { border-collapse: collapse; }
  .pad { padding: 6px 10px; }
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
      body { background:#f4f4ee; color:#1a1a1a; }
      .hdr { background:#0b3d63; color:#fff; }
      .box { border:1px solid #9aa; background:#fff; }
      .btn { font-family:inherit; font-size:12px; padding:3px 12px; }
      a { color:#0b3d63; }
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
      body { background:#241f2b; color:#ece7f2; font-family: Tahoma, sans-serif; }
      .hdr { background:#6d2f7a; color:#ffe9a8; }
      .box { border:2px solid #6d2f7a; background:#2f2838; }
      .btn { font-family:inherit; font-size:12px; padding:5px 16px; background:#ffe9a8; border:1px solid #6d2f7a; }
      a { color:#ffc857; }
      table td { border-color:#4a4256 !important; }
    `,
    reverseResultColumns: true,
  },
};
