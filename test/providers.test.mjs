import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccount, credentialHint, tlsOptionsFor, PRESETS } from '../providers.mjs';

const acct = (email, extra = {}) => ({ id: 't', email, password: 'x', ...extra });

test('163 resolves to 网易 endpoints at the strict TLS level', () => {
  const r = resolveAccount(acct('you@163.com'));
  assert.equal(r.imapHost, 'imap.163.com');
  assert.equal(r.imapPort, 993);
  assert.equal(r.smtpHost, 'smtp.163.com');
  assert.equal(r.smtpPort, 465);
  assert.equal(r.tlsSecLevel, 0);
});

test('VIP domains keep their own hosts', () => {
  const r = resolveAccount(acct('you@vip.163.com'));
  assert.equal(r.imapHost, 'imap.vip.163.com');
  assert.equal(r.smtpHost, 'smtp.vip.163.com');
});

test('sina is marked for the lowered TLS security level', () => {
  const r = resolveAccount(acct('you@sina.com'));
  assert.equal(r.imapHost, 'imap.sina.com');
  assert.equal(r.tlsSecLevel, 1);

  const vip = resolveAccount(acct('you@vip.sina.cn'));
  assert.equal(vip.imapHost, 'imap.vip.sina.cn');
  assert.equal(vip.tlsSecLevel, 1);
});

test('88.com uses imap.88.com', () => {
  const r = resolveAccount(acct('you@88.com'));
  assert.equal(r.imapHost, 'imap.88.com');
  assert.equal(r.smtpHost, 'smtp.88.com');
});

test('custom domain under a known provider resolves by suffix', () => {
  // 完美邮箱的自定义二级域名，MX 指向 mx01.email.cn
  const r = resolveAccount(acct('you@morning.email.cn'));
  assert.equal(r.imapHost, 'imap.email.cn');
  assert.equal(r.smtpHost, 'smtp.email.cn');
  assert.equal(r.label, '完美邮箱 email.cn');
});

test('explicit hosts win over the preset', () => {
  const r = resolveAccount(acct('you@weird.example', { imapHost: 'imap.a', smtpHost: 'smtp.a', tlsSecLevel: 1 }));
  assert.equal(r.imapHost, 'imap.a');
  assert.equal(r.smtpHost, 'smtp.a');
  assert.equal(r.tlsSecLevel, 1);
});

test('unknown domain without explicit hosts throws', () => {
  assert.throws(() => resolveAccount(acct('you@nowhere.invalid')), /无法为 .* 判定服务器/);
});

test('credential hints follow the same suffix matching', () => {
  assert.match(credentialHint('you@163.com'), /客户端授权密码/);
  assert.match(credentialHint('you@morning.email.cn'), /专用密码/);
  assert.match(credentialHint('you@unknown.invalid'), /授权码/);
});

test('tls options only loosen the level when asked', () => {
  const strict = tlsOptionsFor({ tlsSecLevel: 0 });
  assert.deepEqual(strict, { rejectUnauthorized: true });

  const loose = tlsOptionsFor({ tlsSecLevel: 1 });
  assert.equal(loose.rejectUnauthorized, true);
  assert.equal(loose.ciphers, 'DEFAULT@SECLEVEL=1');
});

test('presets cover the three provider families', () => {
  for (const domain of ['163.com', '126.com', 'yeah.net', 'vip.163.com', '188.com', 'sina.com', 'sina.cn', 'vip.sina.com', 'vip.sina.cn', '88.com', 'email.cn']) {
    assert.ok(PRESETS[domain], `missing preset for ${domain}`);
    assert.ok(PRESETS[domain].imap, `missing imap host for ${domain}`);
    assert.ok(PRESETS[domain].smtp, `missing smtp host for ${domain}`);
  }
});