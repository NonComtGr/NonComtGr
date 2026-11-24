/**
 * 尖塔双代 · 联机竞速服务端
 * 零依赖 Node.js 服务：同时提供游戏页面、房间码与进度同步 API。
 *
 * 启动：node server.js
 * 默认端口 8787，可用环境变量 PORT 覆盖。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const GAME_FILE = path.join(ROOT, '尖塔双代.html');
const ROOM_TTL = 2 * 60 * 60 * 1000;
const MAX_PLAYERS = 10;

const rooms = new Map();

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function ok(res, data) { json(res, 200, Object.assign({ ok: true }, data || {})); }
function fail(res, msg, code) { json(res, code || 400, { ok: false, error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function token() { return crypto.randomBytes(16).toString('hex'); }
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}
function cleanName(v) {
  return String(v || '').replace(/[<>&"']/g, '').trim().slice(0, 16) || '无名攀登者';
}
function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    seed: room.seed,
    char: room.char,
    asc: room.asc,
    hostId: room.players[0] && room.players[0].id,
    createdAt: room.createdAt,
    startedAt: room.startedAt || 0,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      char: p.char || room.char,
      asc: p.asc != null ? p.asc : room.asc,
      connected: !p.left && Date.now() - p.lastSeen < 8000,
      left: !!p.left,
      state: p.state || null,
      wonAt: p.wonAt || 0
    })),
    maxPlayers: MAX_PLAYERS,
    leader: leaderName(room),
    winner: winnerName(room)
  };
}
function scoreOf(p) {
  const s = p && p.state;
  if (!s) return 0;
  return (s.won ? 100000 : 0) + (+s.act || 0) * 100 + (+s.floor || 0) * 10 + (+s.hp || 0) * 0.1;
}
function leaderName(room) {
  const active = room.players.filter(p => !p.left);
  if (!active.length) return '';
  let best = active[0];
  active.forEach(p => { if (scoreOf(p) > scoreOf(best)) best = p; });
  return best.name;
}
function winnerName(room) {
  const active = room.players.filter(p => !p.left);
  const done = active.filter(p => p.state && p.state.over);
  const won = active.filter(p => p.state && p.state.won);
  if (won.length) {
    const w = won.sort((a, b) => (a.wonAt || Infinity) - (b.wonAt || Infinity))[0];
    return w ? w.name : '';
  }
  if (active.length && done.length === active.length) {
    const w = active.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0];
    return w ? w.name : '';
  }
  return '';
}
function findPlayer(room, tokenValue) {
  return room.players.find(p => p.token === tokenValue) || null;
}
function cleanup() {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.createdAt > ROOM_TTL) rooms.delete(code);
  });
}

function serveStatic(req, res, pathname) {
  let file = null;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/game') file = GAME_FILE;
  else if (pathname === '/server-info') {
    return ok(res, { port: PORT, lan: lanUrls(), rooms: rooms.size });
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('无法读取游戏文件：' + err.message);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') return ok(res, {});
  try {
    if (pathname === '/api/create' && req.method === 'POST') {
      cleanup();
      const body = await readBody(req);
      const code = newCode();
      if (!code) return fail(res, '房间码已用尽，请稍后重试', 503);
      const char = String(body.char || 'iron');
      const asc = Math.max(0, Math.min(20, Number(body.asc) || 0));
      const seed = String(body.seed || crypto.randomInt(10000000, 99999999));
      const room = {
        code, seed, char, asc,
        status: 'waiting',
        createdAt: Date.now(),
        startedAt: 0,
        players: []
      };
      const player = { id: 1, name: cleanName(body.name), char, asc, token: token(), lastSeen: Date.now(), state: null };
      room.players.push(player);
      rooms.set(code, room);
      return ok(res, { room: publicRoom(room), token: player.token, playerId: 1 });
    }
    if (pathname === '/api/join' && req.method === 'POST') {
      cleanup();
      const body = await readBody(req);
      const code = String(body.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(res, '房间不存在或已过期', 404);
      if (room.status !== 'waiting') return fail(res, '竞速已经开始，无法加入', 409);
      if (room.players.length >= MAX_PLAYERS) return fail(res, '房间已满（最多 ' + MAX_PLAYERS + ' 人）', 409);
      const char = String(body.char || room.char || 'iron');
      const asc = Math.max(0, Math.min(20, Number(body.asc) || 0));
      const used = new Set(room.players.map(p => p.id));
      let id = 1;
      while (used.has(id)) id++;
      const player = { id, name: cleanName(body.name), char, asc, token: token(), lastSeen: Date.now(), state: null };
      room.players.push(player);
      return ok(res, { room: publicRoom(room), token: player.token, playerId: id });
    }
    if (pathname === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      const room = rooms.get(String(body.code || '').toUpperCase());
      if (!room) return fail(res, '房间不存在或已过期', 404);
      const player = findPlayer(room, body.token);
      if (!player || player.id !== 1) return fail(res, '只有房主可以开始', 403);
      const active = room.players.filter(p => !p.left).length;
      if (active < 2) return fail(res, '至少需要 2 名玩家', 409);
      if (room.status !== 'waiting') return fail(res, '竞速已开始', 409);
      room.status = 'racing';
      room.startedAt = Date.now();
      return ok(res, { room: publicRoom(room) });
    }
    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      const room = rooms.get(String(body.code || '').toUpperCase());
      if (!room) return fail(res, '房间不存在或已过期', 404);
      const player = findPlayer(room, body.token);
      if (!player) return fail(res, '身份校验失败', 403);
      player.lastSeen = Date.now();
      if (body.state && typeof body.state === 'object') {
        const s = body.state;
        const wasWon = !!(player.state && player.state.won);
        player.state = {
          act: Math.max(1, Math.min(9, Number(s.act) || 1)),
          floor: Math.max(0, Math.min(999, Number(s.floor) || 0)),
          hp: Math.max(0, Math.min(99999, Number(s.hp) || 0)),
          maxHp: Math.max(1, Math.min(99999, Number(s.maxHp) || 1)),
          gold: Math.max(0, Math.min(999999, Number(s.gold) || 0)),
          kills: Math.max(0, Math.min(99999, Number(s.kills) || 0)),
          over: !!s.over,
          won: !!s.won,
          ts: Date.now()
        };
        if (player.state.won && !wasWon) player.wonAt = Date.now();
        if (!player.state.won) player.wonAt = 0;
      }
      return ok(res, { room: publicRoom(room) });
    }
    if (pathname === '/api/room' && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const room = rooms.get(String(u.searchParams.get('code') || '').toUpperCase());
      if (!room) return fail(res, '房间不存在或已过期', 404);
      const player = findPlayer(room, u.searchParams.get('token') || '');
      if (!player) return fail(res, '身份校验失败', 403);
      player.lastSeen = Date.now();
      return ok(res, { room: publicRoom(room) });
    }
    if (pathname === '/api/leave' && req.method === 'POST') {
      const body = await readBody(req);
      const code = String(body.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return ok(res, {});
      const player = findPlayer(room, body.token);
      if (room.status === 'waiting') {
        if (player) {
          room.players = room.players.filter(p => p !== player);
          if (!room.players.length || player.id === 1) rooms.delete(code);
        }
      } else if (player) {
        player.left = true;
        player.lastSeen = Date.now() - 10000;
      }
      return ok(res, {});
    }
    return fail(res, '未知接口', 404);
  } catch (e) {
    return fail(res, e.message || '服务端错误', 500);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u.pathname);
  return serveStatic(req, res, decodeURIComponent(u.pathname));
});

function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(name => {
    (ifs[name] || []).forEach(net => {
      if (net.family === 'IPv4' && !net.internal) out.push('http://' + net.address + ':' + PORT + '/');
    });
  });
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('尖塔双代 · 联机竞速服务已启动');
  console.log('本机：  http://localhost:' + PORT + '/');
  lanUrls().forEach(url => console.log('局域网：' + url));
  console.log('把地址发给其他玩家，大家打开同一地址即可联机竞速。');
  console.log('按 Ctrl+C 停止服务。');
  console.log('');
});

setInterval(cleanup, 10 * 60 * 1000);
