/**
 * MCC Control Panel v4 - Multi-account backend
 * Architecture:
 *   Browser (index.html)  --WebSocket-->  This server  --PTY-->  MinecraftClient binary
 *
 * Key fixes from v3:
 *   - Token auth actually validated (was buggy in v3)
 *   - Per-account output correctly routed by accountId
 *   - WebSocket ping/pong for connection liveness
 *   - device-code event sent exactly once with correct code regex
 *   - Whitelist auto-accept uses server's regex on actual chat strings
 *   - Proper cleanup on disconnect
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

// ============================================================
// Config
// ============================================================
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

// ============================================================
// Token
// ============================================================
function loadOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t);
  return t;
}
const PANEL_TOKEN = loadOrCreateToken();
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🔐 Panel token:', PANEL_TOKEN);
console.log('  📂 Token file:', TOKEN_FILE);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ============================================================
// Database
// ============================================================
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
function getAccount(id) { return db.accounts.find(a => a.id === id); }

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
    // Server
    if (account.host) args.push('-server', account.host);
    if (account.port) args.push('-port', String(account.port));
    // Login
    if (account.user) {
      args.push('-login', account.user);
    }
    // Auth method - using MCC's -method parameter
    const auth = account.auth || 'offline';
    if (auth === 'microsoft') args.push('-method', 'msa');
    else if (auth === 'mojang') args.push('-method', 'mojang');
    else args.push('-method', 'offline');
    // Bots
    if (account.bots) {
      if (account.bots.antiafk) args.push('-antiafk');
      if (account.bots.autorespond) args.push('-autorespond');
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
    console.log(`[${this.name}] Spawning: ${MCC_BIN} ${args.join(' ')}`);

    try {
      this.pty = pty.spawn(MCC_BIN, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
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

    // Log to file
    const logFile = path.join(LOG_DIR, `${this.id}-${new Date().toISOString().slice(0,10)}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });

    this.pty.onData(data => {
      if (this.logStream) this.logStream.write(data);
      // Send ALL output to all clients (client filters by accountId)
      broadcast({ type: 'output', accountId: this.id, data });
      this.handleOutput(data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      console.log(`[${this.name}] exited code=${exitCode} signal=${signal}`);
      this.alive = false;
      this.status = 'offline';
      if (this.logStream) { try { this.logStream.end(); } catch {} this.logStream = null; }
      broadcast({ type: 'account-status', id: this.id, status: 'offline' });
    });

    broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    return true;
  }

  handleOutput(data) {
    // Device code detection - Microsoft uses "code <XXXX>" pattern
    if (!this.deviceCodeSent && (
      data.includes('https://microsoft.com/devicelogin') ||
      data.includes('To sign in, use a web browser') ||
      data.includes('device code')
    )) {
      this.status = 'waiting';
      broadcast({ type: 'account-status', id: this.id, status: 'waiting' });
      // Extract code - various formats
      const m = data.match(/code[:\s]+([A-Z0-9]{6,})/i) ||
                data.match(/enter the code[:\s]+([A-Z0-9]{6,})/i) ||
                data.match(/\[([A-Z0-9]{6,})\]/);
      if (m) {
        this.deviceCodeSent = true;
        broadcast({
          type: 'device-code',
          accountId: this.id,
          code: m[1],
          url: 'https://microsoft.com/devicelogin'
        });
        console.log(`[${this.name}] Device code: ${m[1]}`);
      }
    }
    // Login success
    if (data.match(/Logged in|session.+started|joined the game/i) && this.status !== 'online') {
      this.status = 'online';
      broadcast({ type: 'account-status', id: this.id, status: 'online' });
    }
    // Disconnected
    if (data.match(/Disconnected|Connection lost|Connection closed|kicked from the server/i) && this.status === 'online') {
      this.status = 'connecting';
      broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    }
    // Authentication error
    if (data.match(/Unable to authenticate|Authentication failed|Invalid credentials/i)) {
      this.status = 'error';
      broadcast({ type: 'account-status', id: this.id, status: 'error' });
    }
    // TPA auto-accept
    this.checkWhitelistTpa(data);
  }

  checkWhitelistTpa(data) {
    if (!this.alive || !this.account.bots?.autotp || whitelist.length === 0) return;
    // Various language patterns
    const patterns = [
      // English
      /(\w+)\s+has requested to teleport to you/i,
      /(\w+)\s+wants to teleport to you/i,
      /(\w+)\s+would like to teleport to you/i,
      // English (tphere)
      /(\w+)\s+has requested that you teleport to them/i,
      /(\w+)\s+wants you to teleport to them/i,
      // Chinese
      /(\w+)\s+请求传送到你这里/,
      /(\w+)\s+想要传送到你这里/,
      /(\w+)\s+请求你传送到他那里/,
      /(\w+)\s+想要你传送到他那里/,
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = data.match(patterns[i]);
      if (m) {
        const player = m[1];
        if (whitelist.some(w => w.toLowerCase() === player.toLowerCase())) {
          // Send /tpaccept after a short delay
          setTimeout(() => {
            this.write('/tpaccept\r');
            setTimeout(() => this.write('/tpaccept\r'), 300);
          }, 150);
          const kind = i < 3 ? 'tpa' : 'tphere';
          broadcast({ type: 'tp-auto', accountId: this.id, player, kind });
          console.log(`[${this.name}] Auto-accepted ${kind} from ${player}`);
        }
        return;
      }
    }
  }

  stop() {
    if (this.pty) { try { this.pty.kill('SIGTERM'); } catch (e) {} }
    setTimeout(() => {
      if (this.pty) { try { this.pty.kill('SIGKILL'); } catch (e) {} }
    }, 2000);
  }

  write(text) {
    if (!this.pty || !this.alive) return false;
    try { this.pty.write(text); return true; } catch (e) { return false; }
  }

  sendCommand(cmd) {
    // Send the command + carriage return + newline
    // MCC interprets /-prefixed as commands, plain text as chat
    return this.write(cmd + '\r\n');
  }
}

class AccountManager {
  constructor() { this.sessions = new Map(); }

  ensure(account) {
    if (!this.sessions.has(account.id)) {
      this.sessions.set(account.id, new MCCAccount(account));
    }
    const s = this.sessions.get(account.id);
    s.account = account;
    return s;
  }
  start(account) { return this.ensure(account).start(account); }
  stop(id) { const s = this.sessions.get(id); if (s) s.stop(); }
  startAll() { db.accounts.forEach(a => { if (a.host && a.user) this.start(a); }); }
  stopAll() { this.sessions.forEach(s => s.stop()); }

  listStatus() {
    return db.accounts.map(a => ({
      id: a.id,
      name: a.name,
      host: a.host,
      port: a.port,
      version: a.version,
      auth: a.auth,
      user: a.user,
      bots: a.bots,
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
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

wss.on('connection', (ws, req) => {
  // Auth: token from query string OR header
  const url = new URL(req.url, 'http://x');
  let token = url.searchParams.get('token');
  if (!token && req.headers['authorization']) {
    token = req.headers['authorization'].replace('Bearer ', '');
  }
  if (token !== PANEL_TOKEN) {
    console.log('WS auth failed: invalid token');
    ws.send(JSON.stringify({ type: 'error', msg: 'Token 错误' }));
    setTimeout(() => ws.close(), 100);
    return;
  }
  console.log('WS connected');

  // Send hello with full state
  ws.send(JSON.stringify({
    type: 'hello',
    accounts: manager.listStatus(),
    whitelist
  }));

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWsMessage(ws, msg);
  });

  ws.on('close', () => console.log('WS disconnected'));
  ws.on('error', (e) => console.log('WS error:', e.message));
});

// Heartbeat - drop dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function handleWsMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

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
      if (a) {
        Object.assign(a, msg.account);
        saveDB();
        const s = manager.sessions.get(a.id);
        if (s) s.account = a;
      }
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
        ws.send(JSON.stringify({ type: 'error', msg: '账号未配置完整（需要服务器地址和登录名）' }));
      }
      break;
    }

    case 'stop-account':
      manager.stop(msg.id);
      break;

    case 'start-all':
      manager.startAll();
      break;

    case 'stop-all':
      manager.stopAll();
      break;

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

    default:
      console.log('Unknown msg type:', msg.type);
  }
}

// ============================================================
// Boot
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🌐 Panel:    http://0.0.0.0:${PORT}`);
  console.log(`  🔑 Token:    ${PANEL_TOKEN}`);
  console.log(`  📂 MCC:      ${MCC_BIN} ${fs.existsSync(MCC_BIN) ? '✓' : '✗ 未安装'}`);
  console.log(`  👥 账号:     ${db.accounts.length}`);
  console.log(`  ✅ 白名单:   ${whitelist.length} 人`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGINT', () => { manager.stopAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { manager.stopAll(); server.close(); process.exit(0); });
