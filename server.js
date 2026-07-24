/**
 * MCC Control Panel v2 - Multi-account + Whitelist auto-TPA
 *
 * Features:
 *  - Multiple MCC accounts simultaneously
 *  - Microsoft / Mojang device-code login (web modal shows the code)
 *  - Whitelist: auto-accept /tpa and /tphere from whitelisted players
 *  - Per-account config & bots
 *  - Per-account console output (frontend only shows active)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

// ============== Config ==============
const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MCC_DIR = process.env.MCC_DIR || path.join(ROOT, 'Minecraft-Console-Client');
const MCC_BIN = process.env.MCC_BIN || path.join(MCC_DIR, 'MinecraftClient');
const TOKEN_FILE = path.join(ROOT, 'config', 'token.txt');
const DB_FILE = path.join(ROOT, 'config', 'accounts.json');
const WHITELIST_FILE = path.join(ROOT, 'config', 'whitelist.json');
const LOG_DIR = path.join(ROOT, 'logs');

[LOG_DIR, path.dirname(TOKEN_FILE)].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ============== Token ==============
function loadOrCreateToken() {
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t);
  return t;
}
const PANEL_TOKEN = loadOrCreateToken();
console.log('🔐 Panel token:', PANEL_TOKEN);

// ============== Database ==============
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { accounts: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { accounts: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')); } catch { return []; }
}
function saveWhitelist(wl) { fs.writeFileSync(WHITELIST_FILE, JSON.stringify(wl, null, 2)); }

let db = loadDB();
let whitelist = loadWhitelist();

function getAccount(id) { return db.accounts.find(a => a.id === id); }
function updateAccount(id, updater) {
  const a = getAccount(id);
  if (a) { updater(a); saveDB(db); }
  return a;
}

// ============== MCC Account session ==============
class MCCAccount {
  constructor(account) {
    this.id = account.id;
    this.name = account.name;
    this.pty = null;
    this.alive = false;
    this.status = 'offline';
    this.startedAt = null;
    this.account = account;
  }

  start(account) {
    if (this.alive) return false;
    if (!fs.existsSync(MCC_BIN)) {
      broadcast({ type: 'error', msg: 'MCC binary not found at ' + MCC_BIN });
      return false;
    }

    // Build MCC command args
    const args = [];
    if (account.host) args.push('-server', account.host);
    if (account.port) args.push('-port', String(account.port));
    if (account.user) args.push('-login', account.user);

    // Auth method
    const auth = account.auth || 'offline';
    if (auth === 'microsoft') args.push('-method', 'msa');
    else if (auth === 'mojang') args.push('-method', 'mojang');
    else if (auth === 'offline') args.push('-method', 'offline');

    // Bots
    if (account.bots) {
      if (account.bots.antiafk) args.push('-antiafk');
      if (account.bots.autorespond) args.push('-autorespond');
      if (account.bots.logchat) args.push('-chatlog');
    }

    console.log(`🚀 [${this.name}] Starting: ${MCC_BIN} ${args.join(' ')}`);

    try {
      this.pty = pty.spawn(MCC_BIN, args, {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: MCC_DIR,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (e) {
      broadcast({ type: 'error', msg: `启动 MCC 失败 [${this.name}]: ${e.message}` });
      return false;
    }

    this.alive = true;
    this.status = 'connecting';
    this.startedAt = Date.now();
    this.account = account;

    const logFile = fs.createWriteStream(
      path.join(LOG_DIR, `${this.id}-${new Date().toISOString().slice(0,10)}.log`),
      { flags: 'a' }
    );

    this.pty.onData(data => {
      logFile.write(data);
      broadcast({ type: 'output', accountId: this.id, data });
      this.handleOutput(data);
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`⚠️  [${this.name}] exited (code=${exitCode})`);
      this.alive = false;
      this.status = 'offline';
      broadcast({ type: 'account-status', id: this.id, status: 'offline' });
    });

    broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    return true;
  }

  handleOutput(data) {
    // Detect device code
    if (data.includes('https://microsoft.com/devicelogin') || data.includes('To sign in, use a web browser')) {
      this.status = 'waiting-code';
      broadcast({ type: 'account-status', id: this.id, status: 'waiting-code' });
      const codeMatch = data.match(/code\s+([A-Z0-9]{8,})/i);
      if (codeMatch) {
        broadcast({
          type: 'device-code',
          accountId: this.id,
          code: codeMatch[1],
          url: 'https://microsoft.com/devicelogin',
          instructions: '用浏览器打开网址，输入代码'
        });
      }
    }
    // Detect successful login
    if (data.match(/Logged in|session.+started|joined the game/i)) {
      this.status = 'online';
      broadcast({ type: 'account-status', id: this.id, status: 'online' });
    }
    // Detect disconnection
    if (data.match(/Disconnect|Connection lost|kicked/i) && this.status === 'online') {
      this.status = 'connecting';
      broadcast({ type: 'account-status', id: this.id, status: 'connecting' });
    }
    // Detect TPA requests and auto-accept if in whitelist
    this.autoAcceptTpa(data);
  }

  autoAcceptTpa(data) {
    if (!this.alive) return;
    if (!this.account.bots?.autotp) return;
    if (whitelist.length === 0) return;

    // Common patterns:
    //   "PlayerName has requested to teleport to you."
    //   "PlayerName wants you to teleport to them."
    //   "PlayerName 请求传送到你这里"
    //   "PlayerName 请求你传送到他那里"
    const tpaToMe = data.match(/(\w+)\s+(?:has requested to teleport to you|请求传送到你这里|wants to teleport to you)/i);
    const tpaToThem = data.match(/(\w+)\s+(?:has requested that you teleport|请求你传送到|requested you to teleport)/i);

    for (const m of [tpaToMe, tpaToThem]) {
      if (!m) continue;
      const player = m[1];
      if (whitelist.some(w => w.toLowerCase() === player.toLowerCase())) {
        setTimeout(() => {
          // Try multiple accept commands for compatibility
          this.write('/tpaccept\r');
          setTimeout(() => this.write('/tpaccept\r'), 200);
          broadcast({ type: 'tp-auto', accountId: this.id, player, kind: m === tpaToMe ? 'tpa' : 'tphere' });
          console.log(`✅ [${this.name}] Auto-accepted ${m === tpaToMe ? 'TPA' : 'TPHERE'} from ${player} (whitelist)`);
        }, 100);
      }
    }
  }

  stop() {
    if (this.pty) { try { this.pty.kill(); } catch (e) {} }
  }
  write(text) {
    if (!this.pty || !this.alive) return false;
    this.pty.write(text);
    return true;
  }
  sendCommand(cmd) { return this.write(cmd + '\r'); }
}

// ============== Manager ==============
class AccountManager {
  constructor() {
    this.sessions = new Map();
  }
  ensure(account) {
    if (!this.sessions.has(account.id)) {
      this.sessions.set(account.id, new MCCAccount(account));
    }
    const s = this.sessions.get(account.id);
    s.account = account; // keep config fresh
    return s;
  }
  start(account) {
    const s = this.ensure(account);
    return s.start(account);
  }
  stop(id) {
    const s = this.sessions.get(id);
    if (s) s.stop();
  }
  startAll() {
    db.accounts.forEach(a => {
      if (a.host && a.user) this.start(a);
    });
  }
  stopAll() { this.sessions.forEach(s => s.stop()); }
  listStatus() {
    return db.accounts.map(a => ({
      ...a,
      pass: undefined, // never send password to frontend
      status: this.sessions.get(a.id)?.status || 'offline'
    }));
  }
}
const manager = new AccountManager();

// ============== Express + WebSocket ==============
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ accounts: manager.listStatus(), whitelist });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}
function broadcastAccountList() {
  broadcast({ type: 'accounts', accounts: manager.listStatus() });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== PANEL_TOKEN) {
    ws.send(JSON.stringify({ type: 'error', msg: 'Invalid token' }));
    ws.close();
    return;
  }
  console.log('🔌 WS connected');
  ws.send(JSON.stringify({
    type: 'hello',
    accounts: manager.listStatus(),
    whitelist
  }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create-account': {
        const id = 'acc-' + crypto.randomBytes(4).toString('hex');
        const newAcc = {
          id, name: '账号 ' + (db.accounts.length + 1),
          host: '', port: '25565', version: '',
          auth: 'offline', user: '', pass: '',
          bots: { autoreconnect: true, antiafk: true, logchat: true, autotp: true }
        };
        db.accounts.push(newAcc);
        saveDB(db);
        broadcastAccountList();
        break;
      }
      case 'update-account': {
        const a = getAccount(msg.account.id);
        if (a) {
          Object.assign(a, msg.account);
          a.pass = a.pass || ''; // keep field
          saveDB(db);
          const session = manager.sessions.get(a.id);
          if (session) session.account = a;
        }
        break;
      }
      case 'delete-account': {
        manager.stop(msg.id);
        db.accounts = db.accounts.filter(a => a.id !== msg.id);
        manager.sessions.delete(msg.id);
        saveDB(db);
        broadcastAccountList();
        break;
      }
      case 'start-account': {
        const a = getAccount(msg.id);
        if (a && a.host) manager.start(a);
        else broadcast({ type: 'error', msg: '账号未配置完整（需要服务器地址）' });
        break;
      }
      case 'stop-account': manager.stop(msg.id); break;
      case 'start-all': manager.startAll(); break;
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
        whitelist = Array.isArray(msg.whitelist) ? msg.whitelist : [];
        saveWhitelist(whitelist);
        broadcast({ type: 'whitelist-update', whitelist });
        break;
      }
      case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
    }
  });

  ws.on('close', () => console.log('🔌 WS disconnected'));
});

// ============== Boot ==============
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🌐 Panel:  http://0.0.0.0:${PORT}`);
  console.log(`  🔑 Token:  ${PANEL_TOKEN}`);
  console.log(`  📂 MCC:    ${MCC_BIN}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  👥 Accounts: ${db.accounts.length} configured`);
  console.log(`  ✅ Whitelist: ${whitelist.length} players`);
});

process.on('SIGINT', () => { manager.stopAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { manager.stopAll(); server.close(); process.exit(0); });
