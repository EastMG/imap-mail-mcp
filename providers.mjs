/**
 * Provider presets for the mailboxes this bridge supports.
 *
 * IMAP/SMTP is the only path for these providers — none of them ships an agent
 * API or MCP endpoint. 网易 in particular requires an RFC 2971 ID command after
 * login; imapflow sends it automatically (and re-sends after LOGIN, which is
 * what 163 actually demands), so we never hand-roll that.
 *
 * Any account can override imapHost / smtpHost in accounts.json.
 */

export const PRESETS = {
  // 网易
  '163.com': { imap: 'imap.163.com', smtp: 'smtp.163.com', label: '网易 163' },
  '126.com': { imap: 'imap.126.com', smtp: 'smtp.126.com', label: '网易 126' },
  'yeah.net': { imap: 'imap.yeah.net', smtp: 'smtp.yeah.net', label: '网易 yeah' },
  'vip.163.com': { imap: 'imap.vip.163.com', smtp: 'smtp.vip.163.com', label: '网易 VIP163' },
  'vip.126.com': { imap: 'imap.vip.126.com', smtp: 'smtp.vip.126.com', label: '网易 VIP126' },
  '188.com': { imap: 'imap.188.com', smtp: 'smtp.188.com', label: '网易 188' },

  // 新浪 —— IMAP 端用的是 1024 位 DH 密钥，OpenSSL 3 默认安全级别会直接拒绝
  // （ERR_SSL_DH_KEY_TOO_SMALL）。这里降到 SECLEVEL=1，只对新浪生效。
  'sina.com': { imap: 'imap.sina.com', smtp: 'smtp.sina.com', label: '新浪', tlsSecLevel: 1 },
  'sina.cn': { imap: 'imap.sina.cn', smtp: 'smtp.sina.cn', label: '新浪 sina.cn', tlsSecLevel: 1 },
  'vip.sina.com': { imap: 'imap.vip.sina.com', smtp: 'smtp.vip.sina.com', label: '新浪 VIP', tlsSecLevel: 1 },
  'vip.sina.cn': { imap: 'imap.vip.sina.cn', smtp: 'smtp.vip.sina.cn', label: '新浪 VIP .cn', tlsSecLevel: 1 },

  // 完美邮箱
  '88.com': { imap: 'imap.88.com', smtp: 'smtp.88.com', label: '完美邮箱 88' },
  // 完美邮箱的自有/自定义域名（MX 指向 mx01.email.cn），客户端入口在 email.cn 上
  'email.cn': { imap: 'imap.email.cn', smtp: 'smtp.email.cn', label: '完美邮箱 email.cn' },
};

/** Longest suffix match, so custom domains under a known provider resolve too. */
function presetFor(domain) {
  if (!domain) return {};
  if (PRESETS[domain]) return PRESETS[domain];
  const hit = Object.keys(PRESETS)
    .filter((k) => domain === k || domain.endsWith(`.${k}`))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? PRESETS[hit] : {};
}

/** Resolve an account entry to concrete endpoints. */
export function resolveAccount(account) {
  const domain = String(account.email || '').split('@')[1]?.toLowerCase();
  const preset = presetFor(domain);
  const imapHost = account.imapHost || preset.imap;
  const smtpHost = account.smtpHost || preset.smtp;

  if (!imapHost || !smtpHost) {
    throw new Error(
      `无法为 ${account.email} 判定服务器：未知域名 ${domain || '(空)'}。` +
        '请在 accounts.json 里显式填写 imapHost 与 smtpHost。',
    );
  }

  return {
    id: account.id || domain,
    email: account.email,
    password: account.password,
    label: account.label || preset.label || domain,
    imapHost,
    imapPort: account.imapPort || 993,
    imapSecure: account.imapSecure !== false,
    smtpHost,
    smtpPort: account.smtpPort || 465,
    smtpSecure: account.smtpSecure !== false,
    tlsSecLevel: Number(account.tlsSecLevel ?? preset.tlsSecLevel ?? 0) || 0,
  };
}

/** How to get credentials, per provider — shown in errors so the user knows where to look. */
export const CREDENTIAL_HINTS = {
  '163.com': '网易：网页版 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 生成「客户端授权密码」',
  '126.com': '网易：网页版 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 生成「客户端授权密码」',
  'yeah.net': '网易：网页版 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 生成「客户端授权密码」',
  'sina.com': '新浪：网页版 设置区 → 客户端POP/IMAP/SMTP → 开启 IMAP4/SMTP → 获取 16 位授权码',
  'sina.cn': '新浪：网页版 设置区 → 客户端POP/IMAP/SMTP → 开启 IMAP4/SMTP → 获取 16 位授权码',
  '88.com': '完美邮箱：设置 → 常规设置 → 客户端设置 → 启用 IMAP/SMTP → 新建「专用密码」',
  'email.cn': '完美邮箱：设置 → 常规设置 → 客户端设置 → 启用 IMAP/SMTP → 新建「专用密码」',
};

export function credentialHint(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  const exact = CREDENTIAL_HINTS[domain];
  if (exact) return exact;
  const key = Object.keys(CREDENTIAL_HINTS)
    .filter((k) => domain === k || domain.endsWith(`.${k}`))
    .sort((a, b) => b.length - a.length)[0];
  if (key) return CREDENTIAL_HINTS[key];
  const family = domain.startsWith('vip.') ? domain.slice(4) : domain;
  return CREDENTIAL_HINTS[family] || '请在邮箱网页版开启 IMAP/SMTP 并生成授权码（不是登录密码）';
}

/**
 * TLS options for one resolved account.
 *
 * Node 24 / OpenSSL 3 rejects anything below its default security level, and
 * 新浪's IMAP endpoint still serves a 1024-bit DH key → ERR_SSL_DH_KEY_TOO_SMALL.
 * Lowering the level only for those hosts keeps every other account strict.
 */
export function tlsOptionsFor(account) {
  const opts = { rejectUnauthorized: true };
  if (account.tlsSecLevel > 0) opts.ciphers = `DEFAULT@SECLEVEL=${account.tlsSecLevel}`;
  return opts;
}