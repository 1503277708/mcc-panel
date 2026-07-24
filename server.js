/**
 * MCC Control Panel v6
 * - MCSM 8 inspired REST API
 * - Per-account MCC instance (one PTY each)
 * - Microsoft device-code flow + offline
 * - Whitelist auto-accept TPA/TPHERE
 * - No token auth (single user, network-level security)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MCC_DIR = path.join(ROOT, 'Minecraft-Console-Client');
const MCC_BIN = path.join(MCC_DIR, 'MinecraftClient');
const DB_FILE = path.join(ROOT, 'config', 'accounts.json');
const WHITELIST_FILE = path.join(ROOT, 'config', 'whitelist.json');
const LOG_DIR = path.join(ROOT, 'logs');

[LOG_DIR, path.dirname(DB_FILE)].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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
const SERVER_START = Date.now();

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

  buildArgs(account, method) {
    const args = [];
    if (account.host) args.push('-server', account.host);
    if (account.port) args.push('-port', String(account.port));
    if (account.user) args.push('-login', account.user);
    const m = method || account.auth || 'offline';
    if (m === 'msa' || m === 'microsoft') args.push('-method', 'msa');
    else if (m === 'mojang') args.push('-method', 'mojang');
    else args.push('-method', 'offline');
    if (account.bots) {
      if (account.bots.antiafk) args.push('-antiafk');
      if (account.bots.chatlog) args.push('-chatlog');
    }
    return args;
  }

  start(account, method) {
    if (this.alive) return false;
    if (!fs.existsSync(MCC_BIN)) {
      broadcast({ type: 'log', accountId: this.id, line: '❌ MCC 未安装: ' + MCC_BIN, level: 'error' });
      this.status = 'error';
      broadcastStatus(this.id, 'error');
      return false;
    }

    const args = this.buildArgs(account, method);
    console.log(`[${this.name}] ${MCC_BIN} ${args.join(' ')}`);

    try {
      this.pty = pty.spawn(MCC_BIN, args, {
        name: 'xterm-256color',
        cols: 120, rows: 30,
        cwd: MCC_DIR,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (e) {
      broadcast({ type: 'log', accountId: this.id, line: '❌ 启动失败: ' + e.message, level: 'error' });
      this.status = 'error';
      broadcastStatus(this.id, 'error');
      return false;
    }

    this.alive = true;
    this.status = 'connecting';
    this.startedAt = Date.now();
    this.account = account;
    this.deviceCodeSent = false;

    const logFile = path.join(LOG_DIR, `${this.id}-${new Date().toISOString().slice(0,10)}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });

    broadcastStatus(this.id, 'connecting');
    broadcast({ type: 'log', accountId: this.id, line: `▶ 启动: ${MCC_BIN} ${args.join(' ')}`, level: 'system' });

    this.pty.onData(data => {
      if (this.logStream) this.logStream.write(data);
      // Strip ANSI and split into lines
      const clean = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      clean.split(/\r?\n/).forEach(line => {
        line = line.trim();
        if (line) {
          broadcast({ type: 'log', accountId: this.id, line, level: 'output' });
        }
      });
      this.handleOutput(clean);
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`[${this.name}] exited code=${exitCode}`);
      this.alive = false;
      this.status = 'offline';
      if (this.logStream) { try { this.logStream.end(); } catch {} this.logStream = null; }
      broadcast({ type: 'log', accountId: this.id, line: `⏹ 已退出 (code=${exitCode})`, level: 'system' });
      broadcastStatus(this.id, 'offline');
    });

    return true;
  }

  handleOutput(data) {
    // ====== DEVICE CODE DETECTION ======
    if (!this.deviceCodeSent) {
      const urlMatch = data.match(/(https?:\/\/(?:microsoft\.com\/(?:link|devicelogin)|login\.live\.com\/oauth20_authorize\.srf)[^\s]*)/i);
      const codeMatch = data.match(/(?:code|user code|enter the code)[:\s]+([A-Z0-9]{4,12})/i) ||
                        data.match(/enter[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i) ||
                        data.match(/\b([A-Z0-9]{8})\b/);

      if (urlMatch && codeMatch) {
        this.status = 'waiting';
        this.deviceCodeSent = true;
        broadcast({
          type: 'device-code',
          accountId: this.id,
          code: codeMatch[1],
          url: urlMatch[1]
        });
        broadcastStatus(this.id, 'waiting');
        console.log(`[${this.name}] Device code: ${codeMatch[1]} | URL: ${urlMatch[1]}`);
      }
    }
    // ====== LOGIN SUCCESS ======
    if (data.match(/Logged in|session.+started|joined the game|Login successful/i) && this.status !== 'online') {
      this.status = 'online';
      broadcastStatus(this.id, 'online');
      broadcast({ type: 'log', accountId: this.id, line: '✅ 已登录服务器', level: 'system' });
    }
    // ====== DISCONNECTED ======
    if (data.match(/Disconnected|Connection lost|Connection closed|kicked/i) && this.status === 'online') {
      this.status = 'connecting';
      broadcastStatus(this.id, 'connecting');
    }
    // ====== AUTH FAILURE ======
    if (data.match(/Unable to authenticate|Authentication failed|Invalid credentials|WrongPassword/i)) {
      this.status = 'error';
      broadcastStatus(this.id, 'error');
    }
    // ====== WHITELIST TPA AUTO-ACCEPT ======
    this.checkWhitelistTpa(data);
  }

  checkWhitelistTpa(data) {
    if (!this.alive || !this.account.bots?.autotp || whitelist.length === 0) return;
    const patterns = [
      /(\w+)\s+has requested to teleport to you/i,
      /(\w+)\s+wants to teleport to you/i,
      /(\w+)\s+would like to teleport to you/i,
      /(\w+)\s+请求传送到你这里/,
      /(\w+)\s+想要传送到你这里/,
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
          broadcast({ type: 'log', accountId: this.id, line: `🤖 Auto-accept ${kind} from ${player}`, level: 'system' });
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
  start(a, method) { return this.ensure(a).start(a, method); }
  stop(id) { const s = this.sessions.get(id); if (s) s.stop(); }
  stopAll() { this.sessions.forEach(s => s.stop()); }
  listStatus() {
    return db.accounts.map(a => ({
      id: a.id, name: a.name, host: a.host, port: a.port,
      player: a.user, auth: a.auth, bots: a.bots,
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

// ---- API ----

app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  const totalLogs = fs.existsSync(LOG_DIR) ?
    fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).length : 0;
  res.json({
    accounts: manager.listStatus(),
    whitelist,
    serverStart: SERVER_START,
    system: {
      node: process.version,
      memory: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
      logs: totalLogs,
      platform: `${os.platform()} ${os.arch()}`,
    },
    mccInstalled: fs.existsSync(MCC_BIN),
  });
});

app.get('/api/instances', (req, res) => res.json({ instances: manager.listStatus() }));

app.post('/api/instances', (req, res) => {
  const { name, host, port, player, antiafk, chatlog } = req.body;
  if (!name || !host || !player) return res.status(400).json({ error: 'name/host/player required' });
  const id = 'acc-' + crypto.randomBytes(4).toString('hex');
  const acc = {
    id, name, host, port: parseInt(port) || 25565,
    user: player, auth: 'offline',
    bots: { antiafk: !!antiafk, chatlog: chatlog !== false, autotp: true }
  };
  db.accounts.push(acc);
  saveDB();
  broadcast({ type: 'accounts', accounts: manager.listStatus() });
  res.json({ id, accounts: manager.listStatus() });
});

app.put('/api/instances/:id', (req, res) => {
  const a = getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { name, host, port, player } = req.body;
  if (name) a.name = name;
  if (host) a.host = host;
  if (port) a.port = parseInt(port) || 25565;
  if (player) a.user = player;
  // Stop if running
  const s = manager.sessions.get(a.id);
  if (s && s.alive) s.stop();
  saveDB();
  broadcast({ type: 'accounts', accounts: manager.listStatus() });
  res.json({ ok: true, accounts: manager.listStatus() });
});

app.delete('/api/instances/:id', (req, res) => {
  manager.stop(req.params.id);
  db.accounts = db.accounts.filter(a => a.id !== req.params.id);
  manager.sessions.delete(req.params.id);
  saveDB();
  broadcast({ type: 'accounts', accounts: manager.listStatus() });
  res.json({ ok: true, accounts: manager.listStatus() });
});

app.post('/api/instances/:id/start', (req, res) => {
  const a = getAccount(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const method = req.body.method || 'offline';
  a.auth = method;
  saveDB();
  const ok = manager.start(a, method);
  res.json({ ok, status: manager.sessions.get(a.id)?.status });
});

app.post('/api/instances/:id/stop', (req, res) => {
  manager.stop(req.params.id);
  res.json({ ok: true });
});

app.post('/api/instances/:id/command', (req, res) => {
  const s = manager.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const ok = s.sendCommand(req.body.cmd || '');
  res.json({ ok });
});

app.get('/api/whitelist', (req, res) => res.json({ whitelist }));

app.put('/api/whitelist', (req, res) => {
  if (Array.isArray(req.body.players)) {
    whitelist = req.body.players.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    saveWhitelist();
    broadcast({ type: 'whitelist', whitelist });
    res.json({ ok: true, whitelist });
  } else {
    res.status(400).json({ error: 'players must be array' });
  }
});

// ---- WebSocket ----

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const d = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(d); });
}
function broadcastStatus(id, status) {
  broadcast({ type: 'status', accountId: id, status });
}

wss.on('connection', (ws, req) => {
  // No login - just accept any connection
  console.log('WS connected');
  ws.send(JSON.stringify({ type: 'accounts', accounts: manager.listStatus(), whitelist }));

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => console.log('WS disconnected'));
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// ============================================================
// Boot
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🌐 Panel:  http://0.0.0.0:${PORT}`);
  console.log(`  📂 MCC:    ${MCC_BIN} ${fs.existsSync(MCC_BIN) ? '✓' : '✗ MISSING'}`);
  console.log(`  👤 Single-user mode (no token)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGINT', () => { manager.stopAll && manager.stopAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
