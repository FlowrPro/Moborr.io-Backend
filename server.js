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

// Wall system (must match client)
const WALLS = [];

function generateMazeWalls() {
  const wallThickness = 600; // Very thick walls
  const mapW = MAP_BOUNDS.w;
  const mapH = MAP_BOUNDS.h;
  
  // Main perimeter-like wall on the left side, winding up
  WALLS.push({
    x: 0,
    y: 0,
    width: wallThickness,
    height: mapH * 0.4
  });
  
  // Wall extends right from top-left
  WALLS.push({
    x: 0,
    y: 0,
    width: mapW * 0.35,
    height: wallThickness
  });
  
  // First major turn - goes down on the right side of top section
  WALLS.push({
    x: mapW * 0.3,
    y: wallThickness,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  // Horizontal wall in middle-left area - dead end
  WALLS.push({
    x: 0,
    y: mapH * 0.35,
    width: mapW * 0.25,
    height: wallThickness
  });
  
  // Major vertical wall in center - creates main corridor
  WALLS.push({
    x: mapW * 0.45,
    y: mapH * 0.2,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  // Winding wall on right side - goes up and down
  WALLS.push({
    x: mapW * 0.65,
    y: 0,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  // Right side bottom section - creates a tunnel effect
  WALLS.push({
    x: mapW * 0.7,
    y: mapH * 0.45,
    width: mapW * 0.3,
    height: wallThickness
  });
  
  // Bottom perimeter wall - long horizontal (split to create entrance)
  WALLS.push({
    x: 0,
    y: mapH * 0.8,
    width: mapW * 0.15,
    height: wallThickness
  });
  
  // Gap for entrance to middle-bottom square (around x: 0.18-0.25)
  
  // Rest of bottom wall after gap
  WALLS.push({
    x: mapW * 0.3,
    y: mapH * 0.8,
    width: mapW * 0.3,
    height: wallThickness
  });
  
  // Bottom right area - creates winding path
  WALLS.push({
    x: mapW * 0.55,
    y: mapH * 0.65,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  // Center area - creates maze-like dead ends
  WALLS.push({
    x: mapW * 0.2,
    y: mapH * 0.5,
    width: mapW * 0.2,
    height: wallThickness
  });
  
  // Left-center vertical tunnel
  WALLS.push({
    x: mapW * 0.1,
    y: mapH * 0.5,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  // Right-center section - more maze complexity
  WALLS.push({
    x: mapW * 0.75,
    y: mapH * 0.6,
    width: wallThickness,
    height: mapH * 0.2
  });
  
  // Additional winding on bottom-left
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  // Top-right corner tunnel (split to create entrance)
  WALLS.push({
    x: mapW * 0.8,
    y: mapH * 0.15,
    width: mapW * 0.2,
    height: wallThickness * 0.4
  });
  
  // Top-right corner tunnel - second part (gap for entrance in middle)
  WALLS.push({
    x: mapW * 0.8,
    y: mapH * 0.15 + wallThickness * 0.6,
    width: mapW * 0.2,
    height: wallThickness * 0.4
  });
  
  // ===== ENCLOSED SQUARES =====
  
  // Middle-bottom square walls (creates enclosed area)
  // Top wall of middle-bottom square
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7,
    width: mapW * 0.15,
    height: wallThickness
  });
  
  // Right wall of middle-bottom square
  WALLS.push({
    x: mapW * 0.29,
    y: mapH * 0.7,
    width: wallThickness,
    height: mapH * 0.2
  });
  
  // Bottom wall of middle-bottom square
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.88,
    width: mapW * 0.15,
    height: wallThickness
  });
  
  // Left wall of middle-bottom square (split to create entrance from bottom-left square)
  // Left side - partial wall with gap
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7,
    width: wallThickness,
    height: wallThickness * 0.4
  });
  
  // Left side - rest of wall (gap in middle for entrance)
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7 + wallThickness * 0.6,
    width: wallThickness,
    height: mapH * 0.2 - wallThickness * 0.6
  });
  
  // Bottom-left square walls (creates enclosed area)
  // Top wall of bottom-left square (split to create entrance from middle-bottom square)
  WALLS.push({
    x: 0,
    y: mapH * 0.75,
    width: mapW * 0.13,
    height: wallThickness * 0.4
  });
  
  // Top wall of bottom-left square - second part (gap for entrance)
  WALLS.push({
    x: 0,
    y: mapH * 0.75 + wallThickness * 0.6,
    width: mapW * 0.13,
    height: wallThickness * 0.4
  });
  
  // Right wall of bottom-left square
  WALLS.push({
    x: mapW * 0.12,
    y: mapH * 0.75,
    width: wallThickness,
    height: mapH * 0.25
  });
  
  // Bottom wall of bottom-left square
  WALLS.push({
    x: 0,
    y: mapH * 0.98,
    width: mapW * 0.13,
    height: wallThickness
  });
  
  // Left wall of bottom-left square
  WALLS.push({
    x: 0,
    y: mapH * 0.75,
    width: wallThickness * 0.3,
    height: mapH * 0.25
  });
}

function checkWallCollision(x, y, radius) {
  for (const wall of WALLS) {
    const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.width));
    const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.height));
    
    const distX = x - closestX;
    const distY = y - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    
    if (distance < radius) return true;
  }
  return false;
}

const players = new Map(); // socketId -> player
const PLAYER_RADIUS = 26;

function randomSpawn() {
  let x, y;
  // Keep trying to find a spawn point that doesn't collide with walls
  for (let attempts = 0; attempts < 20; attempts++) {
    x = Math.floor( MAP_BOUNDS.padding + Math.random() * (MAP_BOUNDS.w - MAP_BOUNDS.padding * 2) );
    y = Math.floor( MAP_BOUNDS.padding + Math.random() * (MAP_BOUNDS.h - MAP_BOUNDS.padding * 2) );
    if (!checkWallCollision(x, y, PLAYER_RADIUS)) break;
  }
  return { x, y };
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 75% 50%)`;
}

function clamp(val, a, b) {
  return Math.max(a, Math.min(b, val));
}

// Generate walls on server startup
generateMazeWalls();

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
    
    const newX = player.x + player.vx * dt;
    const newY = player.y + player.vy * dt;
    
    // Check collision with walls
    if (!checkWallCollision(newX, newY, PLAYER_RADIUS)) {
      player.x = newX;
      player.y = newY;
    }

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
    io.volatile.emit('stateSnapshot', { now: Date.now(), players: snapshot });
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on http://localhost:${PORT}`);
  if (process.env.CLIENT_ORIGIN) console.log('CLIENT_ORIGIN =', process.env.CLIENT_ORIGIN);
});
