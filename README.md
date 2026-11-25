# imap-mail-mcp

> 一个 stdio MCP 服务器，把**网易 / 新浪 / 完美邮箱**接进 Agent。7 个工具，走 IMAP + SMTP，不需要任何厂商 API。
>
> An MCP server that bridges 网易 (163/126/yeah/188), 新浪 and 完美邮箱 into your agent over IMAP + SMTP. Seven tools, zero vendor APIs — plus the three TLS/IMAP quirks that break every generic mail MCP on Chinese providers.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

## 为什么需要它

这三家**都没有**任何 agent 接口：

| 邮箱 | 官方 API | Agent / MCP |
|---|---|---|
| 网易 163 / 126 / yeah / 188 | 仅企业邮有「接口集成平台」（部门、SSO），不含邮件正文 | 无 |
| 新浪 sina.com / sina.cn | 无对外开放平台 | 无 |
| 完美邮箱 88.com / email.cn | 无 | 无 |

所以只有 **IMAP/SMTP + 授权码**这一条路。通用的 Gmail MCP 拿到这儿会连不上——原因见下面「三个真实的坑」。

## 工具（7 个）

| 工具 | 说明 |
|---|---|
| `list_accounts` | 已配置账号、IMAP/SMTP 端点、已识别的域名 |
| `list_folders` | 文件夹列表（中文名用返回的 `path`，见下） |
| `search_messages` | 按发件人 / 主题 / 全文 / 日期 / 未读搜索，返回 uid + 信封 |
| `read_message` | 读正文（MIME 已解码）+ 附件清单 |
| `download_attachment` | 附件落盘到 `downloads/` |
| `mark_read` | 已读 / 未读 |
| `send_message` | 发信，**必须 `confirmed=true`** |

## 安装

```bash
git clone https://github.com/EastMG/imap-mail-mcp.git
cd imap-mail-mcp
npm install
```

要求 Node ≥ 20（想用 `--use-system-ca` 建议 Node ≥ 24）。

## 配置账号

授权码在各自网页版的「设置 → 客户端 / POP3/IMAP/SMTP」里生成。**不是网页登录密码。**

```bash
node server.mjs add --email you@163.com   --password <客户端授权密码> --id 163
node server.mjs add --email you@sina.com  --password <16 位授权码>   --id sina
node server.mjs add --email you@88.com    --password <专用密码>      --id 88

node server.mjs test      # 逐个验证 IMAP + SMTP 登录
node server.mjs list      # 看配置
```

自定义域名直接给服务器地址：

```bash
node server.mjs add --email you@your-domain.com --password <专用密码> \
  --imap imap.example.com --smtp smtp.example.com
```

也可以手写 `accounts.json`（参考 [`accounts.example.json`](accounts.example.json)）：

```json
[
  { "id": "163", "email": "you@163.com", "password": "…" },
  { "id": "custom", "email": "you@your-domain.com", "password": "…",
    "imapHost": "imap.example.com", "smtpHost": "smtp.example.com", "tlsSecLevel": 1 }
]
```

域名在预设表里的（163 / 126 / yeah / vip.163 / 188 / sina.com / sina.cn / vip.sina.* / 88.com / email.cn）只需邮箱和授权码；子域名会按**最长后缀**匹配，比如 `you@morning.email.cn` 自动落到 `imap.email.cn`。

## 接到 MCP 客户端

**Claude Desktop / Claude Code / 任意 MCP 客户端：**

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mail-mcp/server.mjs"]
    }
  }
}
```

**Windows 上装了卡巴斯基之类的杀软**，要在命令前加一个参数（原因见下）：

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["--use-system-ca", "/absolute/path/to/imap-mail-mcp/server.mjs"]
    }
  }
}
```

工具名会以 `mcp__mail__*` 的形式出现。

## 三个真实的坑

这三条都是实测出来的，也是这个项目存在的主要理由。

### 1. 网易：LOGIN 之后必须发 RFC 2971 `ID`

不发的话连接看着正常，一 `SELECT` 就报：

```
SELECT Unsafe Login. Please contact kefu@188.com for help
```

格式不对也会被拒（`BAD Parse command`）。本项目用 [imapflow](https://github.com/postalsys/imapflow)，它在 `startSession()` 里检测 `ID` 能力并在认证后**再发一次**——这正是 163 要求的。

### 2. 杀软 TLS 中间人：Node 不读 Windows 证书库

卡巴斯基这类软件会解密 IMAP/SMTP 流量，你拿到的是它自签的根签发的证书：

```
*.163.com ← Kaspersky Anti-Virus Personal Root Certificate（自签根）
```

浏览器、Thunderbird 都正常（它们读系统证书库），Node 只读内置 CA，于是：

```
SELF_SIGNED_CERT_IN_CHAIN  self-signed certificate in certificate chain
```

两种解法：

```bash
# A. 让 node 读系统证书库（推荐，Node ≥ 24）
node --use-system-ca server.mjs test

# B. 只信任那一张根证书
export NODE_EXTRA_CA_CERTS=/path/to/kaspersky-root.pem
```

### 3. 新浪：1024 位 DH，OpenSSL 3 直接拒

```
ERR_SSL_DH_KEY_TOO_SMALL
```

预设表给新浪 4 个域名标了 `tlsSecLevel: 1`，落到 `ciphers: "DEFAULT@SECLEVEL=1"`，**只作用于新浪**，其它账号仍是默认（最严）级别。自建服务器想降级，在 `accounts.json` 里写 `"tlsSecLevel": 1`。

## 中文文件夹名

IMAP 协议层是 modified UTF-7。`list_folders` 返回两个字段：

```json
{ "path": "&f1F62ZAad+U-/已发送", "name": "已发送", "specialUse": "\\Sent" }
```

调 `search_messages` / `read_message` 时**把 `path` 原样传**，不要手写中文。`INBOX` 不受影响。

## 安全模型

- `accounts.json` 权限 `0600`、原子写入，密码只存本机；`.gitignore` 已排除，不会进版本库。
- `send_message` 不带 `confirmed=true` 直接抛错，要求先把「发件账号 / 收件人 / 主题 / 正文」展示给用户；每次真实发送追加一行到 `sends.log`。
- **这不是强保证**——模型仍可能自己填 `confirmed=true`。工具层无法验证「用户真的同意了」，要硬管控请在客户端侧做审批。
- 每调用一条连接、用完 logout；`disableAutoIdle`，不维持常驻连接。
- `logger: false`：stdout 是 MCP 协议通道，任何日志都会破坏分帧，诊断信息走 stderr。

## 已知边界

- 网易对第三方 IMAP 有频率限制，密集拉取可能被临时限制（返回 `Unsafe Login` 或连接被拒），隔几分钟再试。
- 不做 IDLE / 推送：agent 只能主动查询，不会自动收到新邮件。
- 附件在内存里解析，超大附件（> 50 MB）可能吃内存。
- 草稿保存（APPEND 到 Drafts）未实现，发信是直接发。
- 私密笔记、思维导图之类与邮件无关的能力一概没有。

## 开发

```bash
npm test          # node:test，覆盖域名解析 / TLS 级别 / 凭证提示
npm start         # 本地起 MCP（stdio）
```

## License

[MIT](LICENSE)