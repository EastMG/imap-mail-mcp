#!/usr/bin/env node
/**
 * Multi-account IMAP/SMTP mail server over MCP stdio.
 *
 * Spawned by DSH on demand — no resident process, no port.
 * Supports 网易 (163/126/yeah/vip/188), 新浪 (sina.com / sina.cn / vip.*) and
 * 完美邮箱 (88.com), plus any other provider via explicit imapHost/smtpHost.
 *
 * Why IMAP: none of these providers ships an agent API or MCP endpoint.
 * 网易 additionally demands an RFC 2971 ID command after LOGIN; imapflow sends
 * it (and re-sends after auth), which is what 163 actually enforces.
 *
 * CLI:
 *   node server.mjs serve                 Start MCP over stdio (DSH does this)
 *   node server.mjs add --email .. --password .. [--id ..]
 *   node server.mjs list
 *   node server.mjs test [--account id]   Verify IMAP + SMTP login
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { resolveAccount, PRESETS, credentialHint, tlsOptionsFor } from './providers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.join(HERE, 'accounts.json');
const DOWNLOAD_DIR = path.join(HERE, 'downloads');
const SEND_LOG = path.join(HERE, 'sends.log');

/* --------------------------------------------------------------- accounts */

function readAccounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAccounts(list) {
  const tmp = `${ACCOUNTS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_PATH);
}

function pickAccount(id) {
  const accounts = readAccounts();
  if (!accounts.length) {
    throw new Error(
      `还没有配置任何账号。先运行：node server.mjs add --email 你的邮箱 --password 授权码\n` +
        `（${credentialHint('x@163.com')}）`,
    );
  }
  if (!id) return resolveAccount(accounts[0]);
  const hit =
    accounts.find((a) => a.id === id) ||
    accounts.find((a) => a.email.toLowerCase() === String(id).toLowerCase()) ||
    accounts.find((a) => a.email.toLowerCase().startsWith(String(id).toLowerCase()));
  if (!hit) throw new Error(`找不到账号 "${id}"。已配置：${accounts.map((a) => a.id).join(', ')}`);
  return resolveAccount(hit);
}

/* ----------------------------------------------------------- imap helpers */

function makeClient(acc) {
  return new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.email, pass: acc.password },
    logger: false,
    // 网易 requires a well-formed ID; imapflow re-sends after LOGIN when needed.
    clientInfo: { name: 'dsh-mail', version: '1.0.0', vendor: 'DSH', 'support-email': acc.email },
    tls: tlsOptionsFor(acc),
    disableAutoIdle: true,
  });
}

/** Map a TLS/protocol failure to an actionable hint. */
function tlsHint(err) {
  const blob = `${err?.code || ''} ${err?.message || ''}`;
  if (/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER|unable to verify/i.test(blob)) {
    return (
      'TLS 证书校验失败：本机杀毒软件（本机是卡巴斯基）会在中间人解密流量，' +
      '它的根证书只装在 Windows 证书库，Node 默认不读。用 node --use-system-ca 启动即可（或用 NODE_EXTRA_CA_CERTS 指根证书）。'
    );
  }
  if (/ERR_SSL_DH_KEY_TOO_SMALL/i.test(blob)) {
    return 'TLS 握手失败：对端用的是 1024 位 DH 参数，OpenSSL 3 默认拒绝。在 accounts.json 给该账号加 "tlsSecLevel": 1。';
  }
  return '';
}

/** Run `fn` against a fresh IMAP connection, always logging out. */
async function withClient(acc, fn) {
  const client = makeClient(acc);
  try {
    await client.connect();
  } catch (err) {
    const hint = tlsHint(err);
    throw new Error(
      `连接 ${acc.imapHost} 失败：${err.message}\n` +
        (hint ? `${hint}\n` : '') +
        `常见原因：① 用的是登录密码而不是授权码/专用密码；② 网页端没开启 IMAP/SMTP；③ 网易偶发限制，稍后重试。\n` +
        credentialHint(acc.email),
    );
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

function fmtEnvelope(env) {
  if (!env) return {};
  return {
    subject: env.subject || '(无主题)',
    date: env.date ? new Date(env.date).toISOString() : '',
    from: (env.from || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
    to: (env.to || []).map((a) => a.address).join(', '),
  };
}

/* --------------------------------------------------------------- tools */

export async function listAccounts() {
  const accounts = readAccounts();
  return {
    count: accounts.length,
    accounts: accounts.map((a) => {
      const r = resolveAccount(a);
      return {
        id: r.id,
        email: r.email,
        label: r.label,
        imap: `${r.imapHost}:${r.imapPort}`,
        smtp: `${r.smtpHost}:${r.smtpPort}`,
        hasPassword: Boolean(a.password),
      };
    }),
    knownDomains: Object.keys(PRESETS),
  };
}

export async function listFolders({ account }) {
  const acc = pickAccount(account);
  return withClient(acc, async (client) => {
    const boxes = await client.list();
    return {
      account: acc.id,
      count: boxes.length,
      folders: boxes.map((b) => ({
        path: b.path,
        name: b.name,
        specialUse: b.specialUse || '',
        flags: b.flags ? [...b.flags] : [],
      })),
    };
  });
}

export async function searchMessages({
  account, mailbox = 'INBOX', from, subject, text, since, before, unseen, limit = 20,
}) {
  const acc = pickAccount(account);
  const criteria = {};
  if (from) criteria.from = from;
  if (subject) criteria.subject = subject;
  if (text) criteria.text = text;
  if (since) criteria.since = new Date(since);
  if (before) criteria.before = new Date(before);
  if (unseen === true) criteria.unseen = true;
  if (!Object.keys(criteria).length) criteria.all = true;

  return withClient(acc, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = await client.search(criteria, { uid: true });
      const picked = (uids || []).slice(-Math.min(Math.max(limit, 1), 100)).reverse();
      const messages = [];
      for (const uid of picked) {
        const msg = await client.fetchOne(uid, { envelope: true, flags: true, bodyStructure: true }, { uid: true });
        if (!msg) continue;
        messages.push({
          uid,
          seen: msg.flags ? msg.flags.has('\\Seen') : false,
          attachments: countAttachments(msg.bodyStructure),
          ...fmtEnvelope(msg.envelope),
        });
      }
      return { account: acc.id, mailbox, matched: (uids || []).length, returned: messages.length, messages };
    } finally {
      lock.release();
    }
  });
}

function countAttachments(structure) {
  if (!structure) return 0;
  let n = 0;
  const walk = (node) => {
    if (!node) return;
    if (node.disposition === 'attachment' || (node.dispositionParameters?.filename)) n += 1;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(structure);
  return n;
}

export async function readMessage({ account, mailbox = 'INBOX', uid, maxChars = 20000 }) {
  if (uid === undefined || uid === null) throw new Error('uid 必填（先用 search_messages 拿到）');
  const acc = pickAccount(account);
  return withClient(acc, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`在 ${mailbox} 里找不到 uid=${uid}`);
      const parsed = await simpleParser(msg.source);
      const text = (parsed.text || '').trim();
      return {
        account: acc.id,
        mailbox,
        uid: Number(uid),
        subject: parsed.subject || '(无主题)',
        date: parsed.date ? new Date(parsed.date).toISOString() : '',
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        truncated: text.length > maxChars,
        text: text.slice(0, maxChars),
        attachments: (parsed.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `attachment-${i}`,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

export async function downloadAttachment({ account, mailbox = 'INBOX', uid, index = 0 }) {
  const acc = pickAccount(account);
  return withClient(acc, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`在 ${mailbox} 里找不到 uid=${uid}`);
      const parsed = await simpleParser(msg.source);
      const list = parsed.attachments || [];
      const att = list[index];
      if (!att) throw new Error(`该邮件没有第 ${index} 个附件（共 ${list.length} 个）`);
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      const safe = String(att.filename || `attachment-${index}`).replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(DOWNLOAD_DIR, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, att.content);
      return { savedTo: file, bytes: att.size, filename: safe };
    } finally {
      lock.release();
    }
  });
}

export async function markRead({ account, mailbox = 'INBOX', uid, read = true }) {
  const acc = pickAccount(account);
  return withClient(acc, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (read) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      return { account: acc.id, mailbox, uid: Number(uid), read: Boolean(read) };
    } finally {
      lock.release();
    }
  });
}

const CONFIRM_REFUSAL =
  '拒绝发送：发信不可撤回。必须先把【发件账号 / 收件人 / 主题 / 正文】完整展示给用户，' +
  '取得明确同意后，再以 confirmed=true 重新调用。';

export async function sendMessage({
  account, to = [], cc = [], bcc = [], subject = '', text = '', html,
  inReplyTo, references, confirmed = false,
}) {
  if (confirmed !== true) throw new Error(CONFIRM_REFUSAL);
  if (!to.length) throw new Error('to 不能为空');
  const acc = pickAccount(account);

  const transport = nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: { user: acc.email, pass: acc.password },
    tls: tlsOptionsFor(acc),
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });

  try {
    const info = await transport.sendMail({
      from: acc.email,
      to: to.join(', '),
      cc: cc.length ? cc.join(', ') : undefined,
      bcc: bcc.length ? bcc.join(', ') : undefined,
      subject,
      text,
      html: html || undefined,
      inReplyTo,
      references,
    });
    fs.appendFileSync(
      SEND_LOG,
      `${JSON.stringify({
        at: new Date().toISOString(),
        account: acc.id,
        from: acc.email,
        to, cc, bcc, subject,
        messageId: info.messageId,
      })}\n`,
      'utf8',
    );
    return { account: acc.id, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } catch (err) {
    const hint = tlsHint(err);
    throw new Error(
      `发信失败（${acc.smtpHost}:${acc.smtpPort}）：${err.message}\n` +
        (hint ? `${hint}\n` : '') +
        credentialHint(acc.email),
    );
  } finally {
    transport.close();
  }
}

/* ------------------------------------------------------------- tool defs */

const STR = (description) => ({ type: 'string', description });
const ADDRESSES = { type: 'array', items: { type: 'string' }, description: 'Plain email addresses.' };

const TOOLS = [
  {
    name: 'list_accounts',
    description: 'List configured mailboxes (网易/新浪/完美邮箱) with their IMAP/SMTP endpoints.',
    inputSchema: { type: 'object', properties: {} },
    handler: listAccounts,
  },
  {
    name: 'list_folders',
    description: 'List IMAP folders for one account.',
    inputSchema: {
      type: 'object',
      properties: { account: STR('Account id or email; omit for the first account') },
    },
    handler: listFolders,
  },
  {
    name: 'search_messages',
    description:
      'Search messages in a mailbox. Returns uid + envelope; use read_message for the body. ' +
      'Chinese folder names must match list_folders output exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        account: STR('Account id or email'),
        mailbox: STR('Folder path, default INBOX'),
        from: STR('Sender contains'),
        subject: STR('Subject contains'),
        text: STR('Full-text search'),
        since: STR('ISO date, inclusive'),
        before: STR('ISO date, exclusive'),
        unseen: { type: 'boolean', description: 'Only unread' },
        limit: { type: 'number', description: '1-100, default 20 (newest first)' },
      },
    },
    handler: searchMessages,
  },
  {
    name: 'read_message',
    description: 'Read one message by uid: headers, decoded plain-text body, attachment list.',
    inputSchema: {
      type: 'object',
      properties: {
        account: STR('Account id or email'),
        mailbox: STR('Folder path, default INBOX'),
        uid: { type: 'number', description: 'From search_messages' },
        maxChars: { type: 'number', description: 'Default 20000' },
      },
      required: ['uid'],
    },
    handler: readMessage,
  },
  {
    name: 'download_attachment',
    description: 'Save one attachment of a message to ./downloads and return the local path.',
    inputSchema: {
      type: 'object',
      properties: {
        account: STR('Account id or email'),
        mailbox: STR('Folder path, default INBOX'),
        uid: { type: 'number' },
        index: { type: 'number', description: 'Zero-based; see read_message attachments' },
      },
      required: ['uid'],
    },
    handler: downloadAttachment,
  },
  {
    name: 'mark_read',
    description: 'Mark a message read or unread.',
    inputSchema: {
      type: 'object',
      properties: {
        account: STR('Account id or email'),
        mailbox: STR('Folder path, default INBOX'),
        uid: { type: 'number' },
        read: { type: 'boolean' },
      },
      required: ['uid'],
    },
    handler: markRead,
  },
  {
    name: 'send_message',
    description:
      'SEND a real email. IRREVERSIBLE. Show the user account/recipients/subject/body first, ' +
      'get explicit approval, then call with confirmed=true. Every send is logged to sends.log.',
    inputSchema: {
      type: 'object',
      properties: {
        account: STR('Which mailbox sends it'),
        to: ADDRESSES,
        cc: ADDRESSES,
        bcc: ADDRESSES,
        subject: STR('Subject'),
        text: STR('Plain-text body'),
        html: STR('Optional HTML body'),
        inReplyTo: STR('Message-ID being replied to'),
        references: STR('References header'),
        confirmed: { type: 'boolean', description: 'true only after explicit user approval' },
      },
      required: ['to', 'confirmed'],
    },
    handler: sendMessage,
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------- mcp loop */

const PROTOCOL_VERSION = '2025-06-18';

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imap-mail', version: '1.0.0' },
        },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      if (!isNotification) write({ jsonrpc: '2.0', id, result: {} });
      return;

    case 'tools/list':
      write({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      });
      return;

    case 'tools/call': {
      const tool = TOOL_MAP.get(params?.name);
      if (!tool) {
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true } });
        return;
      }
      try {
        const out = await tool.handler(params?.arguments || {});
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false } });
      } catch (err) {
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(err?.message || err) }], isError: true } });
      }
      return;
    }

    default:
      if (!isNotification) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function serve() {
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          return;
        }
        await handle(msg);
      });
    }
  });
  process.stdin.on('end', () => chain.finally(() => process.exit(0)));
  const accounts = readAccounts();
  console.error(`[imap-mail] stdio ready — accounts=${accounts.length}, tools=${TOOLS.length}`);
}

/* -------------------------------------------------------------------- cli */

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function cmdAdd(argv) {
  const email = flag(argv, '--email');
  const password = flag(argv, '--password');
  if (!email || !password) {
    console.error(
      '用法: node server.mjs add --email <邮箱> --password <授权码> [--id <别名>] ' +
        '[--imap <host>] [--smtp <host>] [--label <显示名>]',
    );
    process.exitCode = 2;
    return;
  }
  const accounts = readAccounts();
  const id = flag(argv, '--id') || email.split('@')[0] + '-' + email.split('@')[1];
  const existing = accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  const entry = { id, email, password };
  // 自定义域名（如 morning.email.cn 走 email.cn 的入口）可以直接显式指定服务器
  for (const [k, v] of [['imapHost', flag(argv, '--imap')], ['smtpHost', flag(argv, '--smtp')], ['label', flag(argv, '--label')]]) {
    if (v) entry[k] = v;
  }
  if (existing >= 0) accounts[existing] = { ...accounts[existing], ...entry };
  else accounts.push(entry);
  writeAccounts(accounts);
  console.log(`[imap-mail] 已保存 ${email}（id=${id}）`);
  const r = resolveAccount(entry);
  console.log(`[imap-mail] IMAP ${r.imapHost}:${r.imapPort} / SMTP ${r.smtpHost}:${r.smtpPort}`);
  console.log('[imap-mail] 下一步：node server.mjs test');
}

function cmdList() {
  const accounts = readAccounts();
  if (!accounts.length) {
    console.log('还没有配置账号。用 node server.mjs add --email .. --password ..');
    return;
  }
  for (const a of accounts) {
    const r = resolveAccount(a);
    console.log(`${r.id.padEnd(20)} ${a.email.padEnd(28)} IMAP ${r.imapHost} / SMTP ${r.smtpHost}`);
  }
}

async function cmdTest(argv) {
  const accounts = readAccounts();
  if (!accounts.length) {
    console.error('还没有配置账号。');
    process.exitCode = 2;
    return;
  }
  const target = flag(argv, '--account');
  const list = target ? [pickAccount(target)] : accounts.map(resolveAccount);
  let failed = 0;
  for (const acc of list) {
    process.stdout.write(`${acc.id} (${acc.email}) ... `);
    try {
      const folders = await withClient(acc, async (c) => (await c.list()).length);
      process.stdout.write(`IMAP OK (${folders} 个文件夹) `);
    } catch (e) {
      failed += 1;
      process.stdout.write(`IMAP 失败: ${String(e.message).split('\n')[0]}\n`);
      continue;
    }
    try {
      const t = nodemailer.createTransport({
        host: acc.smtpHost, port: acc.smtpPort, secure: acc.smtpSecure,
        auth: { user: acc.email, pass: acc.password },
        tls: tlsOptionsFor(acc),
        connectionTimeout: 15000,
      });
      await t.verify();
      t.close();
      process.stdout.write('SMTP OK\n');
    } catch (e) {
      failed += 1;
      process.stdout.write(`SMTP 失败: ${String(e.message).split('\n')[0]}\n`);
    }
  }
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  if (failed) process.exitCode = 1;
}

const HELP = `imap-mail-mcp — MCP server for 网易 / 新浪 / 完美邮箱 (IMAP + SMTP)

用法:
  node server.mjs serve                 # 启动 MCP（stdio），由客户端 spawn
  node server.mjs add --email <邮箱> --password <授权码> [--id <别名>]
                      [--imap <host>] [--smtp <host>] [--label <显示名>]
  node server.mjs list                  # 看已配置账号
  node server.mjs test [--account <id>] # 验证 IMAP + SMTP 登录
  node server.mjs --version
  node server.mjs --help

注意:
  password 填「授权码 / 专用密码」，不是网页登录密码。
  本机若有杀软做 TLS 中间人（如卡巴斯基），需要 node --use-system-ca server.mjs ...
`;

function version() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const [cmd = 'serve', ...rest] = process.argv.slice(2);

if (cmd === 'serve') serve();
else if (cmd === 'add') await cmdAdd(rest);
else if (cmd === 'list') cmdList();
else if (cmd === 'test') await cmdTest(rest);
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') console.log(HELP);
else if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(version());
else {
  console.error(HELP);
  process.exitCode = 1;
}