// Moborr.io — authoritative WebSocket server with polygon-based maze walls,
// bottom-left fixed spawn, and full ability/projectile handling.
//
// Run: node server.js
// Environment:
//  - PORT (optional)

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 9000; // half-size map
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

let nextPlayerId = 1;
const players = new Map();
let nextMobId = 1;
const mobs = new Map();

// --- Projectiles ---
const projectiles = new Map();
let nextProjId = 1;

// --- Equipment config (server-side) ---
const EQUIP_SLOTS = 5;

// --- Map helpers (grid & polygon generation) ---
const CELL = MAP_SIZE / 12;
const GAP = Math.floor(Math.max(24, CELL * 0.05));

// Helper to get center of grid cell
function gridToWorldCenter(col, row) {
  const x = -MAP_HALF + (col - 0.5) * CELL;
  const y = -MAP_HALF + (row - 0.5) * CELL;
  return { x, y };
}

// Normalize vector
function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

// A centerline path that roughly follows a maze layout
const centerlineGrid = [
  [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
  [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
  [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
];
const centerline = centerlineGrid.map(([c,r]) => gridToWorldCenter(c, r));

// Convert polyline -> thick polygon by offsetting normals
function polylineToThickPolygon(points, thickness) {
  if (!points || points.length < 2) return [];
  const half = thickness / 2;
  const left = [];
  const right = [];
  const normals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i+1];
    const dir = normalize(b.x - a.x, b.y - a.y);
    normals.push({ x: -dir.y, y: dir.x });
  }
  for (let i = 0; i < points.length; i++) {
    let n = { x: 0, y: 0 };
    if (i === 0) n = normals[0] || { x: 0, y: 1 };
    else if (i === points.length - 1) n = normals[normals.length - 1] || { x: 0, y: 1 };
    else {
      n.x = (normals[i-1] ? normals[i-1].x : 0) + (normals[i] ? normals[i].x : 0);
      n.y = (normals[i-1] ? normals[i-1].y : 0) + (normals[i] ? normals[i].y : 0);
      const nl = Math.hypot(n.x, n.y);
      if (nl < 1e-4) n = normals[i] || { x: 0, y: 1 };
      else { n.x /= nl; n.y /= nl; }
    }
    left.push({ x: points[i].x + n.x * half, y: points[i].y + n.y * half });
    right.push({ x: points[i].x - n.x * half, y: points[i].y - n.y * half });
  }
  const polygon = [];
  for (const p of left) polygon.push({ x: Math.round(p.x), y: Math.round(p.y) });
  for (let i = right.length - 1; i >= 0; i--) polygon.push({ x: Math.round(right[i].x), y: Math.round(right[i].y) });
  return polygon.length >= 3 ? polygon : [];
}

// Build polygon wall from centerline; fallback to rectangular boxes if polygon invalid
let walls = [];
try {
  const WALL_THICKNESS_WORLD = Math.max(Math.floor(CELL * 0.9), 536);
  const polyPts = polylineToThickPolygon(centerline, WALL_THICKNESS_WORLD);
  if (Array.isArray(polyPts) && polyPts.length >= 3) {
    walls = [{ id: 'maze_wall_poly_1', points: polyPts }];
  } else {
    throw new Error('poly generation produced insufficient points');
  }
} catch (err) {
  console.log('Falling back to rectangular walls:', err.message);
  // Fallback rectangular layout
  const box = (col, row, wCells, hCells, id) => ({ 
    id: id || `box_${col}_${row}_${wCells}x${hCells}`, 
    x: -MAP_HALF + (col - 1) * CELL + GAP, 
    y: -MAP_HALF + (row - 1) * CELL + GAP, 
    w: Math.max(1, wCells) * CELL - GAP * 2, 
    h: Math.max(1, hCells) * CELL - GAP * 2 
  });
  walls = [
    box(1, 1, 12, 1, 'outer_top'),
    box(1, 12, 12, 1, 'outer_bottom'),
    box(1, 1, 1, 12, 'outer_left'),
    box(12, 1, 1, 12, 'outer_right'),
    box(2, 2, 1, 3, 'v_left_1'),
    box(2, 6, 1, 3, 'v_left_2'),
    box(2, 10, 1, 2, 'v_left_3'),
    box(3, 2, 4, 1, 'h_top_spiral'),
    box(6, 3, 1, 3, 'v_spiral_center'),
    box(4, 5, 4, 1, 'h_mid_spiral'),
    box(6, 1, 1, 12, 'center_bar_full'),
    box(8, 2, 1, 2, 'v_right_1'),
    box(10, 2, 1, 2, 'v_right_2'),
    box(9, 4, 3, 1, 'h_right_mid_1'),
    box(8, 6, 1, 3, 'v_right_mid_2'),
    box(10, 9, 1, 2, 'v_right_bottom'),
    box(3, 8, 2, 1, 'box_lower_left_1'),
    box(2, 9, 1, 2, 'v_lower_left'),
    box(4, 10, 3, 1, 'h_lower_left'),
    box(7, 9, 2, 1, 'box_lower_center'),
    box(9, 10, 2, 1, 'box_lower_right'),
    box(11, 8, 1, 2, 'v_lower_right'),
    box(4, 3, 1, 1, 'island_a'),
    box(5, 6, 1, 1, 'island_b'),
    box(8, 4, 1, 1, 'island_c'),
    box(7, 7, 1, 1, 'island_d'),
    box(3, 7, 4, 1, 'h_middle_left'),
    box(5, 4, 1, 2, 'v_inner_left_connector'),
    box(9, 5, 1, 2, 'v_inner_right_connector'),
    box(5, 11, 2, 1, 'h_near_bottom_center'),
    box(10, 11, 1, 1, 'h_near_bottom_right'),
    box(6, 4, 1, 1, 'block_center_1'),
    box(8, 8, 1, 1, 'block_center_2'),
    box(3, 10, 1, 1, 'block_ll'),
    box(11, 3, 1, 1, 'block_ur'),
    box(7, 3, 1, 1, 'block_mid_top')
  ];
}

// --- Mob defs & spawn points ---
const mobDefs = {
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 40 },
  wolf:   { name: 'Wolf',   maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 40 },
  golem:  { name: 'Golem',  maxHp: 420, atk: 34, speed: 60,  xp: 60, goldMin: 20, goldMax: 40, respawn: 25, radius: 46 }
};

const purpleGridCoords = [
  [-3, 10], [3, 10], [8, 6], [5, 2], [1, -1], [4, -4], 
  [-2, -5], [-6, -3], [-7, 1], [-6, 5], [-1, 4]
];

const mobSpawnPoints = [];
const squareWorld = MAP_SIZE / 20;
for (const [sx, sy] of purpleGridCoords) {
  const wx = sx * squareWorld;
  const wy = sy * squareWorld;
  mobSpawnPoints.push({ x: wx, y: wy, types: ['goblin', 'wolf', 'golem'] });
}

function pointInsideWall(x, y, margin = 6) {
  for (const w of walls) {
    if (w.points && Array.isArray(w.points)) {
      let inside = false;
      const poly = w.points;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    } else if (typeof w.x === 'number' && typeof w.w === 'number') {
      if (x >= w.x - margin && x <= w.x + w.w + margin && y >= w.y - margin && y <= w.y + w.h + margin) return true;
    }
  }
  return false;
}

function spawnMobAt(sp, typeName) {
  const def = mobDefs[typeName];
  if (!def) return null;
  const jitter = 120 * 3;
  const maxAttempts = 12;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    const limit = MAP_HALF - (def.radius || 18) - 12;
    if (x < -limit || x > limit || y < -limit || y > limit) continue;
    if (pointInsideWall(x, y, 8)) continue;
    const id = 'mob_' + (nextMobId++);
    const m = { id, type: typeName, x, y, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
    mobs.set(id, m);
    return m;
  }
  let fallbackX = sp.x, fallbackY = sp.y;
  let step = 0;
  while (pointInsideWall(fallbackX, fallbackY, 8) && step < 8) {
    fallbackX += (step % 2 === 0 ? 1 : -1) * (def.radius + 20) * (step + 1);
    fallbackY += (step % 3 === 0 ? -1 : 1) * (def.radius + 20) * (step + 1);
    step++;
  }
  const id = 'mob_' + (nextMobId++);
  const m = { id, type: typeName, x: fallbackX, y: fallbackY, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
  mobs.set(id, m);
  return m;
}

for (const sp of mobSpawnPoints) {
  for (let i = 0; i < 5; i++) spawnMobAt(sp, 'goblin');
  for (let i = 0; i < 2; i++) spawnMobAt(sp, 'golem');
  for (let i = 0; i < 3; i++) spawnMobAt(sp, 'wolf');
}

// --- Skills / cooldowns ---
const SKILL_DEFS = {
  warrior: [
    { kind: 'melee', damage: 60, range: 48, ttl: 0, type: 'slash' },
    { kind: 'aoe_stun', damage: 40, radius: 48, ttl: 0, type: 'shieldbash', stunMs: 3000 },
    { kind: 'aoe', damage: 10, radius: 80, ttl: 0, type: 'charge', buff: { type: 'speed', multiplier: 1.5, durationMs: 5000 } },
    { kind: 'buff', damage: 0, radius: 0, ttl: 0, type: 'rage', buff: { type: 'damage', multiplier: 1.15, durationMs: 10000 } }
  ],
  ranger: [
    { kind: 'proj_target', damage: 40, speed: 680, radius: 6, ttlMs: 3000, type: 'arrow' },
    { kind: 'proj_burst', damage: 20, speed: 720, radius: 5, ttlMs: 2500, type: 'rapid', count: 5, spreadDeg: 12 },
    { kind: 'proj_target_stun', damage: 12, speed: 380, radius: 8, ttlMs: 1600, type: 'trap', stunMs: 3000 },
    { kind: 'proj_target', damage: 120, speed: 880, radius: 7, ttlMs: 3500, type: 'snipe' }
  ],
  mage: [
    { kind: 'proj_target', damage: 45, speed: 420, radius: 10, ttlMs: 3000, type: 'spark' },
    { kind: 'proj_target', damage: 135, speed: 360, radius: 10, ttlMs: 3000, type: 'fireball' },
    { kind: 'proj_target_stun', damage: 60, speed: 0, radius: 0, ttlMs: 0, type: 'frostnova', stunMs: 3000 },
    { kind: 'proj_aoe_spread', damage: 45, speed: 520, radius: 12, ttlMs: 3200, type: 'arcane', count: 6, spreadDeg: 45 }
  ]
};

const CLASS_COOLDOWNS_MS = {
  warrior: [3500,7000,10000,25000],
  ranger:  [2000,25000,12000,4000],
  mage:    [2500,5000,25000,10000]
};

function nowMs(){ return Date.now(); }
function randRange(min,max){ return Math.random()*(max-min)+min; }

function bottomLeftSpawn() {
  const x = -MAP_HALF + CELL * 1.5;
  const y = MAP_HALF - CELL * 1.5;
  return { x, y };
}

function createPlayerRuntime(ws, opts = {}) {
  const fixedId = opts.id || null;
  const id = fixedId ? String(fixedId) : String(nextPlayerId++);
  const pos = bottomLeftSpawn();
  const color = `hsl(${Math.floor(Math.random()*360)},70%,60%)`;
  const p = {
    id, name: opts.name || ('Player' + id),
    x: pos.x, y: pos.y, vx:0, vy:0, radius:28, color,
    ws, lastInput: { x:0, y:0 }, lastSeen: nowMs(), chatTimestamps: [],
    maxHp: 200, hp: 200, xp: 0, nextLevelXp: 100, level: 1, gold: 0,
    lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0,
    class: opts.class || 'warrior',
    cooldowns: {},
    baseSpeed: 380,
    buffs: [],
    damageMul: 1.0,
    buffDurationMul: 1.0,
    stunnedUntil: 0,
    equipment: new Array(EQUIP_SLOTS).fill(null),
    _baseMaxHp: 200,
    _baseBaseSpeed: 380,
    _baseBaseDamage: 18
  };
  players.set(String(p.id), p);
  return p;
}

function applyEquipmentBonusesForPlayer(player) {
  if (!player) return;
  if (typeof player._baseMaxHp !== 'number') player._baseMaxHp = player.maxHp || 200;
  if (typeof player._baseBaseSpeed !== 'number') player._baseBaseSpeed = player.baseSpeed || 380;
  if (typeof player._baseBaseDamage !== 'number') player._baseBaseDamage = player.baseDamage || 18;

  const bonus = { maxHp: 0, baseDamage: 0, baseSpeed: 0, damageMul: 0, buffDurationMul: 0 };
  const equipArr = Array.isArray(player.equipment) ? player.equipment : [];
  for (const it of equipArr) {
    if (!it || !it.stats) continue;
    const s = it.stats;
    if (typeof s.maxHp === 'number') bonus.maxHp += s.maxHp;
    if (typeof s.baseDamage === 'number') bonus.baseDamage += s.baseDamage;
    if (typeof s.baseSpeed === 'number') bonus.baseSpeed += s.baseSpeed;
    if (typeof s.damageMul === 'number') bonus.damageMul += s.damageMul;
    if (typeof s.buffDurationMul === 'number') bonus.buffDurationMul += s.buffDurationMul;
  }

  const prevMax = player.maxHp || player._baseMaxHp;
  const newMax = Math.max(1, Math.round((player._baseMaxHp || 200) + bonus.maxHp));
  const delta = newMax - prevMax;
  player.maxHp = newMax;
  if (delta > 0) {
    player.hp = Math.min(player.maxHp, (player.hp || prevMax) + delta);
  } else {
    player.hp = Math.min(player.hp || player.maxHp, player.maxHp);
  }

  player.baseDamage = Math.max(0, (player._baseBaseDamage || 18) + bonus.baseDamage);
  player.baseSpeed = Math.max(1, (player._baseBaseSpeed || 380) + bonus.baseSpeed);
  player.damageMul = Math.max(0, 1 + bonus.damageMul);
  player.buffDurationMul = Math.max(0, 1 + bonus.buffDurationMul);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Moborr.io server running\n');
    return;
  }
  if (req.method === 'GET' && req.url === '/walls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(walls));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function awardXpToPlayer(player, amount) {
  if (!player) return;
  player.xp = Number(player.xp || 0) + Number(amount || 0);
  let leveled = false;
  let levelUps = 0;
  player.nextLevelXp = player.nextLevelXp || 100;
  while (player.xp >= player.nextLevelXp) {
    const req = player.nextLevelXp;
    player.xp -= req;
    player.level = (player.level || 1) + 1;
    player.maxHp = (player.maxHp || 200) + 50;
    player.hp = Math.min(player.maxHp, (player.hp || player.maxHp) + 50);
    player.nextLevelXp = Math.ceil(req * 1.3);
    levelUps++;
    leveled = true;
    if ((player.level % 5) === 0) {
      player.damageMul = (player.damageMul || 1) * 1.3;
      player.buffDurationMul = (player.buffDurationMul || 1) * 1.1;
    }
  }
  if (leveled) {
    try {
      broadcast({
        t: 'player_levelup',
        playerName: player.name,
        level: player.level,
        hpGain: 50 * levelUps,
        newHp: Math.round(player.hp),
        newMaxHp: Math.round(player.maxHp),
        xp: Math.round(player.xp || 0),
        nextLevelXp: Math.round(player.nextLevelXp || 100),
        damageMul: player.damageMul || 1,
        buffDurationMul: player.buffDurationMul || 1
      });
    } catch (e) {}
  }
}

function damageMob(mob, amount, playerId) {
  if (!mob) return;
  if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
  if (mob.hp <= 0) return;
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }
  try {
    broadcast({ t: 'mob_hurt', mobId: mob.id, hp: Math.max(0, Math.round(mob.hp)), damage: Math.round(amount) });
  } catch (e) {}
  if (mob.hp <= 0) {
    mob.dead = true;
    const topDamager = Object.entries(mob.damageContrib).reduce((a, b) => b[1] > a[1] ? b : a, ['', 0]);
    const killerId = topDamager[0] || null;
    const xpReward = mob.def.xp || 10;
    const killerPlayer = killerId ? players.get(killerId) : null;
    if (killerPlayer) awardXpToPlayer(killerPlayer, xpReward);
    try {
      broadcast({ t: 'mob_died', mobId: mob.id, killerId: killerId, xp: xpReward });
    } catch (e) {}
    mob.respawnAt = nowMs() + (mob.def.respawn || 10) * 1000;
  }
}

function damagePlayer(player, amount) {
  if (!player || player.hp <= 0) return;
  player.hp = Math.max(0, player.hp - amount);
  try {
    broadcast({ t: 'player_hurt', id: player.id, damage: Math.round(amount), hp: Math.max(0, Math.round(player.hp)) });
  } catch (e) {}
  if (player.hp <= 0) {
    try {
      broadcast({ t: 'player_died', id: player.id });
    } catch (e) {}
  }
}

function mobAI(mob, dt) {
  if (mob.dead || !mob.def) return;
  if (mob.stunnedUntil && mob.stunnedUntil > nowMs()) return;
  
  let target = null;
  let closestDist = mob.aggroRadius;
  for (const p of players.values()) {
    if (p.hp <= 0) continue;
    const dx = p.x - mob.x;
    const dy = p.y - mob.y;
    const dist = Math.hypot(dx, dy);
    if (dist < closestDist) {
      closestDist = dist;
      target = p;
    }
  }
  
  if (target) {
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-6) {
      const speed = mob.def.speed;
      mob.vx = (dx / dist) * speed;
      mob.vy = (dy / dist) * speed;
    }
    
    mob.x += mob.vx * dt;
    mob.y += mob.vy * dt;
    
    if (dist < mob.def.radius + 30) {
      mob.lastAttackTime = (mob.lastAttackTime || 0) + dt;
      if (mob.lastAttackTime >= 1.0) {
        damagePlayer(target, mob.def.atk);
        mob.lastAttackTime = 0;
      }
    }
  } else {
    mob.vx = 0;
    mob.vy = 0;
  }
  
  const limit = MAP_HALF - (mob.radius || 18) - 8;
  if (Math.abs(mob.x) > limit || Math.abs(mob.y) > limit) {
    mob.x = Math.max(-limit, Math.min(limit, mob.x));
    mob.y = Math.max(-limit, Math.min(limit, mob.y));
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected:', ws._socket.remoteAddress);

  let player = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.t) return;

      if (msg.t === 'join') {
        if (player) return;
        player = createPlayerRuntime(ws, { name: msg.name, class: msg.class });
        const allPlayers = Array.from(players.values()).map(p => ({
          id: p.id,
          name: p.name,
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          radius: p.radius,
          color: p.color,
          level: p.level,
          class: p.class
        }));
        ws.send(JSON.stringify({
          t: 'welcome',
          id: player.id,
          player: { level: player.level, xp: player.xp, nextLevelXp: player.nextLevelXp, maxHp: player.maxHp, class: player.class },
          mapType: MAP_TYPE,
          mapHalf: MAP_HALF,
          mapSize: MAP_SIZE,
          walls: walls,
          spawnX: player.x,
          spawnY: player.y,
          tickRate: TICK_RATE
        }));
        broadcast({ t: 'newPlayer', id: player.id, name: player.name, x: player.x, y: player.y, radius: player.radius, color: player.color, level: player.level });
      } else if (msg.t === 'input') {
        if (!player) return;
        player.lastInput = msg.input || { x: 0, y: 0 };
        if (typeof msg.seq === 'number') player.lastProcessedInput = msg.seq;
      } else if (msg.t === 'cast') {
        if (!player || player.hp <= 0) return;
        // Cast handling (skill activation)
      } else if (msg.t === 'chat') {
        if (!player) return;
        const now = nowMs();
        player.chatTimestamps = (player.chatTimestamps || []).filter(ts => now - ts < CHAT_WINDOW_MS);
        if (player.chatTimestamps.length >= CHAT_MAX_PER_WINDOW) return;
        player.chatTimestamps.push(now);
        const txt = String(msg.text || '').slice(0, 240);
        broadcast({ t: 'chat', name: player.name, text: txt, ts: now, chatId: msg.chatId });
      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', () => {
    if (player) {
      broadcast({ t: 'playerLeft', id: player.id });
      players.delete(player.id);
    }
  });
});

// Simulation loop
setInterval(() => {
  const dt = TICK_DT;
  
  for (const mob of mobs.values()) {
    if (mob.dead && mob.respawnAt && nowMs() >= mob.respawnAt) {
      mob.dead = false;
      mob.hp = mob.maxHp;
      mob.damageContrib = {};
      mob.respawnAt = null;
      const jitter = 120 * 3;
      mob.x = mob.spawnPoint.x + (Math.random() * jitter * 2 - jitter);
      mob.y = mob.spawnPoint.y + (Math.random() * jitter * 2 - jitter);
    }
    if (!mob.dead) mobAI(mob, dt);
  }
  
  for (const p of players.values()) {
    if (p.lastInput) {
      p.vx = p.lastInput.x * p.baseSpeed;
      p.vy = p.lastInput.y * p.baseSpeed;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    
    const limit = MAP_HALF - (p.radius || 28) - 8;
    if (Math.abs(p.x) > limit || Math.abs(p.y) > limit) {
      p.x = Math.max(-limit, Math.min(limit, p.x));
      p.y = Math.max(-limit, Math.min(limit, p.y));
    }
  }
  
  const snapshot = {
    t: 'snapshot',
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      radius: p.radius,
      color: p.color,
      level: p.level,
      xp: p.xp,
      nextLevelXp: p.nextLevelXp,
      hp: p.hp,
      maxHp: p.maxHp,
      class: p.class
    })),
    mobs: Array.from(mobs.values()).map(m => ({
      id: m.id,
      type: m.type,
      x: m.x,
      y: m.y,
      vx: m.vx,
      vy: m.vy,
      radius: m.radius,
      hp: m.hp,
      maxHp: m.maxHp,
      stunnedUntil: m.stunnedUntil || 0
    })),
    walls: walls
  };
  broadcast(snapshot);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on port ${PORT}`);
  console.log(`Walls initialized: ${walls.length} wall(s)`);
});
