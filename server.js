/**
 * MCC Control Panel v5
 * - Login method picker: offline / Microsoft device code
 * - Per-account MCC instance (one PTY each)
 * - Whitelist auto-accept TPA/TPHERE
 * - Token auth (fixed), heartbeats, auto-reconnect
 *
 * MCC 微软登录调用方式：
 *   MinecraftClient -server <host> -port <port> -login <user> -method msa
 *   MCC 内部会:
 *     1. 调用 Microsoft.RequestDeviceCode() 拿到 {VerificationUri, UserCode}
 *     2. Microsoft.OpenBrowser(VerificationUri) → 在服务器上 xdg-open (headless 时会失败但不影响)
 *     3. 轮询 token
 *   所以我们只要在 PTY 输出里抓 VerificationUri 和 UserCode 即可
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MCC_DIR = path.join(ROOT, 'Minecraft-Console-Client');
const MCC_BIN = path.join(MCC_DIR, 'MinecraftClient');
const TOKEN_FILE = path.join(ROOT, 'config', 'token.txt');
const DB_FILE = path.join(ROOT, 'config', 'accounts.json');
const WHITELIST_FILE = path.join(ROOT, 'config', 'whitelist.json');
const LOG_DIR = path.join(ROOT, 'logs');

[LOG_DIR, path.dirname(TOKEN_FILE)].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function loadOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t);
  return t;
}
const PANEL_TOKEN = loadOrCreateToken();
console.log('🔐 Token:', PANEL_TOKEN);

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { accounts: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { accounts: [] }; }
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')); } catch { return []; }
}
function saveWhitelist() { fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2)); }

let db = loadDB();
let whitelist = loadWhitelist();
const getAccount = id => db.accounts.find(a => a.id === id);

// ============================================================
// MCC Account Session
// ============================================================
class MCCAccount {
  constructor(account) {
    this.id = account.id;
    this.name = account.name;
    this.pty = null;
    this.alive = false;
    this.status = 'offline';
    this.startedAt = null;
    this.account = account;
    this.logStream = null;
    this.deviceCodeSent = false;
  }

  buildArgs(account) {
    const args = [];
    if (account.host) args.push('-server', account.host);
    if (account.port) args.push('-port', String(account.port));
    if (account.user) args.push('-login', account.user);
    // Auth - we use -method flag
    const auth = account.auth || 'offline';
    if (auth === 'microsoft') args.push('-method', 'msa');
    else if (auth === 'mojang') args.push('-method', 'mojang');
    else args.push('-method', 'offline');
    // Bots
    if (account.bots) {
      if (account.bots.antiafk) args.push('-antiafk');
      if (account.bots.logchat) args.push('-chatlog');
    }
    return args;
  }

  start(account) {
    if (this.alive) return false;
    if (!fs.existsSync(MCC_BIN)) {
      broadcast({ type: 'error', msg: 'MCC 未安装: ' + MCC_BIN });
      return false;
    }

    const args = this.buildArgs(account);
    console.log(`[${this.name}] ${MCC_BIN} ${args.join(' ')}`);

    try {
      this.pty = pty.spawn(MCC_BIN, args, {
        name: 'xterm-256color',
        cols: 120, rows: 30,
        cwd: MCC_DIR,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (e) {
      broadcast({ type: 'error', msg: '启动失败: ' + e.message });
      return false;
    }

    this.alive = true;
    this.status = 'connecting';
    this.startedAt = Date.now();
    this.account = account;
    this.deviceCodeSent = false;

    const logFile = path.join(LOG_DIR, `${this.id}-${new Date().toISOString().slice(0,10)}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });

    this.pty.onData(data => {
      if (this.logStream) this.logStream.write(data);
      broadcast({ type: 'output', accountId: this.id, data });
      this.handleOutput(data);
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`[${this.name}] exited code=${exitCode}`);
      this.alive = false;
      this.status = 'offline';
      if (this.logStream) { try { this.logStream.end(); } catch {} this.logStream = null; }
      broadcast({ type: 'account-status', id: this.id, status: 'offline' });
    });

    broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    return true;
  }

  handleOutput(data) {
    // ====== DEVICE CODE DETECTION ======
    // MCC's MicrosoftMCCLogin prints: "To sign in, use a web browser to open the page [URL] and enter the code [CODE] to authenticate."
    // Also may print: "Visit https://microsoft.com/link on your PC or phone and enter XXXX-XXXX to sign in"
    // Also: "Device code: XXXX" or "User code: XXXX"
    if (!this.deviceCodeSent) {
      // Pattern 1: standard device code flow URL
      const urlMatch = data.match(/(https?:\/\/(?:microsoft\.com\/(?:link|devicelogin)|login\.live\.com\/oauth20_authorize\.srf)[^\s]*)/i);
      // Pattern 2: code (8+ chars alphanumeric)
      const codeMatch = data.match(/(?:code|user code|enter)[:\s]+([A-Z0-9]{4,12})/i) ||
                        data.match(/enter the code[:\s]+([A-Z0-9]{4,12})/i) ||
                        data.match(/\[([A-Z0-9]{4,12})\]/);

      if (urlMatch && codeMatch) {
        this.status = 'waiting';
        this.deviceCodeSent = true;
        broadcast({
          type: 'device-code',
          accountId: this.id,
          code: codeMatch[1],
          url: urlMatch[1]
        });
        console.log(`[${this.name}] Device code: ${codeMatch[1]} | URL: ${urlMatch[1]}`);
      }
    }
    // ====== LOGIN SUCCESS ======
    if (data.match(/Logged in|session.+started|joined the game|Login successful/i) && this.status !== 'online') {
      this.status = 'online';
      broadcast({ type: 'account-status', id: this.id, status: 'online' });
    }
    // ====== DISCONNECTED ======
    if (data.match(/Disconnected|Connection lost|Connection closed|kicked from the server/i) && this.status === 'online') {
      this.status = 'connecting';
      broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    }
    // ====== AUTH FAILURE ======
    if (data.match(/Unable to authenticate|Authentication failed|Invalid credentials|WrongPassword/i)) {
      this.status = 'error';
      broadcast({ type: 'account-status', id: this.id, status: 'error' });
    }
    // ====== WHITELIST TPA AUTO-ACCEPT ======
    this.checkWhitelistTpa(data);
  }

  checkWhitelistTpa(data) {
    if (!this.alive || !this.account.bots?.autotp || whitelist.length === 0) return;
    const patterns = [
      // TPA → me
      /(\w+)\s+has requested to teleport to you/i,
      /(\w+)\s+wants to teleport to you/i,
      /(\w+)\s+would like to teleport to you/i,
      /(\w+)\s+请求传送到你这里/,
      /(\w+)\s+想要传送到你这里/,
      // TPHERE → them
      /(\w+)\s+has requested that you teleport to them/i,
      /(\w+)\s+wants you to teleport to them/i,
      /(\w+)\s+请求你传送到他那里/,
      /(\w+)\s+想要你传送到他那里/,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = data.match(patterns[i]);
      if (m) {
        const player = m[1];
        if (whitelist.some(w => w.toLowerCase() === player.toLowerCase())) {
          setTimeout(() => {
            this.write('/tpaccept\r\n');
            setTimeout(() => this.write('/tpaccept\r\n'), 300);
          }, 150);
          const kind = i < 5 ? 'tpa' : 'tphere';
          broadcast({ type: 'tp-auto', accountId: this.id, player, kind });
          console.log(`[${this.name}] Auto-accept ${kind} from ${player}`);
        }
        return;
      }
    }
  }

  stop() {
    if (this.pty) { try { this.pty.kill('SIGTERM'); } catch (e) {} }
    setTimeout(() => { if (this.pty) { try { this.pty.kill('SIGKILL'); } catch (e) {} } }, 2000);
  }
  write(text) {
    if (!this.pty || !this.alive) return false;
    try { this.pty.write(text); return true; } catch (e) { return false; }
  }
  sendCommand(cmd) { return this.write(cmd + '\r\n'); }
}

class AccountManager {
  constructor() { this.sessions = new Map(); }
  ensure(a) {
    if (!this.sessions.has(a.id)) this.sessions.set(a.id, new MCCAccount(a));
    const s = this.sessions.get(a.id);
    s.account = a;
    return s;
  }
  start(a) { return this.ensure(a).start(a); }
  stop(id) { const s = this.sessions.get(id); if (s) s.stop(); }
  startAll(method = 'offline') {
    db.accounts.forEach(a => {
      // Override auth method for batch start
      const aCopy = { ...a, auth: method };
      if (aCopy.host && aCopy.user) this.start(aCopy);
    });
  }
  stopAll() { this.sessions.forEach(s => s.stop()); }
  listStatus() {
    return db.accounts.map(a => ({
      id: a.id, name: a.name, host: a.host, port: a.port, version: a.version,
      auth: a.auth, user: a.user, bots: a.bots,
      status: this.sessions.get(a.id)?.status || 'offline'
    }));
  }
}
const manager = new AccountManager();

// ============================================================
// Web layer
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    accounts: manager.listStatus(),
    whitelist,
    mccInstalled: fs.existsSync(MCC_BIN)
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const d = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(d); });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') ||
                (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== PANEL_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', msg: 'Token 错误' }));
    setTimeout(() => ws.close(), 100);
    return;
  }
  console.log('WS connected');
  ws.send(JSON.stringify({ type: 'hello', accounts: manager.listStatus(), whitelist }));

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWs(ws, msg);
  });
  ws.on('close', () => console.log('WS disconnected'));
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function handleWs(ws, msg) {
  switch (msg.type) {
    case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;

    case 'create-account': {
      const id = 'acc-' + crypto.randomBytes(4).toString('hex');
      db.accounts.push({
        id, name: '账号 ' + (db.accounts.length + 1),
        host: '', port: '25565', version: '',
        auth: 'offline', user: '', pass: '',
        bots: { autoreconnect: true, antiafk: true, logchat: true, autotp: true }
      });
      saveDB();
      broadcast({ type: 'accounts', accounts: manager.listStatus() });
      break;
    }

    case 'update-account': {
      const a = getAccount(msg.account.id);
      if (a) { Object.assign(a, msg.account); saveDB(); const s = manager.sessions.get(a.id); if (s) s.account = a; }
      break;
    }

    case 'delete-account': {
      manager.stop(msg.id);
      db.accounts = db.accounts.filter(a => a.id !== msg.id);
      manager.sessions.delete(msg.id);
      saveDB();
      broadcast({ type: 'accounts', accounts: manager.listStatus() });
      break;
    }

    case 'start-account': {
      const a = getAccount(msg.id);
      if (a && a.host && a.user) {
        manager.start(a);
      } else {
        ws.send(JSON.stringify({ type: 'error', msg: '账号未配置完整（需要服务器 IP 和玩家名/邮箱）' }));
      }
      break;
    }

    case 'stop-account': manager.stop(msg.id); break;
    case 'start-all': manager.startAll(msg.method || 'offline'); break;
    case 'stop-all': manager.stopAll(); break;

    case 'cmd': {
      const s = manager.sessions.get(msg.accountId);
      if (s) s.sendCommand(msg.text);
      break;
    }

    case 'input': {
      const s = manager.sessions.get(msg.accountId);
      if (s) s.write(msg.text);
      break;
    }

    case 'whitelist-set': {
      if (Array.isArray(msg.whitelist)) {
        whitelist = msg.whitelist.filter(x => typeof x === 'string' && x.trim());
        saveWhitelist();
        broadcast({ type: 'whitelist-update', whitelist });
      }
      break;
    }

    default: console.log('Unknown msg type:', msg.type);
  }
}

// ============================================================
// Boot
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🌐 Panel:  http://0.0.0.0:${PORT}`);
  console.log(`  🔑 Token:  ${PANEL_TOKEN}`);
  console.log(`  📂 MCC:    ${MCC_BIN} ${fs.existsSync(MCC_BIN) ? '✓' : '✗ 未安装'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGINT', () => { manager.stopAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { manager.stopAll(); server.close(); process.exit(0); });
