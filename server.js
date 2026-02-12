// Moborr.io server — authoritative movement + snapshots with CORS enabled
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow cross-origin socket.io connections (set CLIENT_ORIGIN env to restrict)
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 20000,
  pingTimeout: 60000
});

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Simulation parameters
const TICK_RATE = 30; // server snapshot rate (Hz)
const MAX_INPUT_DT = 0.1; // seconds, clamp input dt

// Movement speed — must match client
const SPEED = 260; // px/sec

// BIG map: 12000 x 12000
const MAP_BOUNDS = { w: 12000, h: 12000, padding: 16 };

const players = new Map(); // socketId -> player

function randomSpawn() {
  return {
    x: Math.floor( MAP_BOUNDS.padding + Math.random() * (MAP_BOUNDS.w - MAP_BOUNDS.padding * 2) ),
    y: Math.floor( MAP_BOUNDS.padding + Math.random() * (MAP_BOUNDS.h - MAP_BOUNDS.padding * 2) )
  };
}
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 75% 50%)`;
}
function clamp(val, a, b) {
  return Math.max(a, Math.min(b, val));
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', (username) => {
    const spawn = randomSpawn();
    const p = {
      id: socket.id,
      username: String(username).slice(0, 20) || 'Player',
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      color: randomColor(),
      lastProcessedInput: 0,
      lastHeard: Date.now()
    };
    players.set(socket.id, p);

    // send initial state
    socket.emit('currentPlayers', Array.from(players.values()));
    // announce new player to others
    socket.broadcast.emit('newPlayer', p);
    console.log('player joined', p.username, 'spawn', spawn);
  });

  // input message: {seq, dt, input: {x, y}}
  socket.on('input', (msg) => {
    const player = players.get(socket.id);
    if (!player) return;

    const now = Date.now();
    player.lastHeard = now;

    const seq = Number(msg.seq) || 0;
    let dt = Number(msg.dt) || (1 / TICK_RATE);
    dt = Math.min(dt, MAX_INPUT_DT);

    // Only process monotonic sequence numbers
    if (seq <= player.lastProcessedInput) return;
    player.lastProcessedInput = seq;

    const input = msg.input || { x: 0, y: 0 };
    let ix = Number(input.x) || 0;
    let iy = Number(input.y) || 0;
    const len = Math.hypot(ix, iy);
    if (len > 1e-6) { ix /= len; iy /= len; }

    // server-authoritative integration (apply input immediately)
    player.vx = ix * SPEED;
    player.vy = iy * SPEED;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // clamp to map bounds
    player.x = clamp(player.x, MAP_BOUNDS.padding, MAP_BOUNDS.w - MAP_BOUNDS.padding);
    player.y = clamp(player.y, MAP_BOUNDS.padding, MAP_BOUNDS.h - MAP_BOUNDS.padding);
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    if (players.has(socket.id)) {
      players.delete(socket.id);
      socket.broadcast.emit('playerLeft', socket.id);
    }
  });
});

// Broadcast authoritative snapshots at TICK_RATE
setInterval(() => {
  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    lastProcessedInput: p.lastProcessedInput,
    username: p.username,
    color: p.color
  }));
  if (snapshot.length) {
    // mark snapshots as volatile so a slow client won't cause queued bursts of old snapshots
    io.volatile.emit('stateSnapshot', { now: Date.now(), players: snapshot });
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on http://localhost:${PORT}`);
  if (process.env.CLIENT_ORIGIN) console.log('CLIENT_ORIGIN =', process.env.CLIENT_ORIGIN);
});
