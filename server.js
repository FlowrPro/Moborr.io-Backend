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

// Wall generation parameters (matching reference game structure)
const WALL_THICKNESS = 480;
const SPAWN_MARGIN = 350;
const CELL_SIZE = MAP_BOUNDS.w / 12;
const CELL_GAP = Math.max(20, CELL_SIZE * 0.05);

const players = new Map(); // socketId -> player
let walls = []; // array of wall rectangles { x, y, w, h }

// ============ WALL GENERATION ============
function generateWalls() {
  walls = [];
  
  // Define maze centerline as grid coordinates (cell indices)
  const centerlineGrid = [
    [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
    [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
    [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
  ];
  
  // Convert grid coordinates to world positions
  const centerline = centerlineGrid.map(([col, row]) => {
    const x = -MAP_BOUNDS.w / 2 + (col - 0.5) * CELL_SIZE;
    const y = -MAP_BOUNDS.h / 2 + (row - 0.5) * CELL_SIZE;
    return { x, y };
  });
  
  // For each cell in the 12x12 grid, determine if it's a wall or path
  const grid = Array(12).fill(null).map(() => Array(12).fill(true)); // true = wall
  
  // Mark centerline cells as paths (false = no wall)
  for (const [col, row] of centerlineGrid) {
    grid[row][col] = false;
  }
  
  // Generate thick wall rectangles around walls
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      if (!grid[row][col]) continue; // skip paths
      
      const wx = -MAP_BOUNDS.w / 2 + col * CELL_SIZE;
      const wy = -MAP_BOUNDS.h / 2 + row * CELL_SIZE;
      
      walls.push({
        x: wx,
        y: wy,
        w: CELL_SIZE,
        h: CELL_SIZE
      });
    }
  }
  
  console.log(`Generated ${walls.length} wall cells`);
}

// ============ COLLISION DETECTION ============
function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w &&
         py >= rect.y && py <= rect.y + rect.h;
}

function resolveCircleRect(entity, rect) {
  const radius = entity.radius || 15;
  
  // Find closest point on rect to circle center
  const closestX = Math.max(rect.x, Math.min(entity.x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(entity.y, rect.y + rect.h));
  
  const dx = entity.x - closestX;
  const dy = entity.y - closestY;
  const dist = Math.hypot(dx, dy);
  
  // No collision
  if (dist >= radius) return;
  
  // Collision detected - push entity out
  if (dist > 0) {
    const overlap = radius - dist + 0.5; // small buffer
    const nx = dx / dist;
    const ny = dy / dist;
    
    entity.x += nx * overlap;
    entity.y += ny * overlap;
    
    // Damp velocity component along collision normal
    const vn = entity.vx * nx + entity.vy * ny;
    if (vn > 0) {
      entity.vx -= vn * nx * 0.8;
      entity.vy -= vn * ny * 0.8;
    }
  } else {
    // Circle center is inside rect - push out in largest direction
    const toRectCenterX = (rect.x + rect.w / 2) - entity.x;
    const toRectCenterY = (rect.y + rect.h / 2) - entity.y;
    
    let nx = 1, ny = 0;
    
    // Find closest edge
    const distToLeft = Math.abs(entity.x - rect.x);
    const distToRight = Math.abs(entity.x - (rect.x + rect.w));
    const distToTop = Math.abs(entity.y - rect.y);
    const distToBottom = Math.abs(entity.y - (rect.y + rect.h));
    
    const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);
    
    if (minDist === distToLeft) { nx = -1; ny = 0; }
    else if (minDist === distToRight) { nx = 1; ny = 0; }
    else if (minDist === distToTop) { nx = 0; ny = -1; }
    else { nx = 0; ny = 1; }
    
    entity.x += nx * (radius + 0.5);
    entity.y += ny * (radius + 0.5);
    entity.vx = 0;
    entity.vy = 0;
  }
}

// ============ MAP BOUNDS + WALL COLLISION ============
function clamp(val, a, b) {
  return Math.max(a, Math.min(b, val));
}

function constrainEntity(entity) {
  const radius = entity.radius || 15;
  
  // Clamp to map bounds
  entity.x = clamp(entity.x, MAP_BOUNDS.padding + radius, MAP_BOUNDS.w - MAP_BOUNDS.padding - radius);
  entity.y = clamp(entity.y, MAP_BOUNDS.padding + radius, MAP_BOUNDS.h - MAP_BOUNDS.padding - radius);
  
  // Resolve wall collisions
  for (const wall of walls) {
    resolveCircleRect(entity, wall);
  }
}

// ============ NETWORKING ============
function randomSpawn() {
  let x, y, valid = false;
  
  // Keep trying to spawn in a non-wall location
  while (!valid) {
    x = Math.floor(SPAWN_MARGIN + Math.random() * (MAP_BOUNDS.w - SPAWN_MARGIN * 2));
    y = Math.floor(SPAWN_MARGIN + Math.random() * (MAP_BOUNDS.h - SPAWN_MARGIN * 2));
    
    // Check if spawn position is not inside a wall
    valid = true;
    for (const wall of walls) {
      if (pointInRect(x, y, wall)) {
        valid = false;
        break;
      }
    }
  }
  
  return { x, y };
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 75% 50%)`;
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
      vy: 0,
      radius: 15,
      color: randomColor(),
      lastProcessedInput: 0,
      lastHeard: Date.now()
    };
    players.set(socket.id, p);

    // send initial state (including walls)
    socket.emit('currentPlayers', {
      players: Array.from(players.values()),
      walls: walls,
      mapBounds: MAP_BOUNDS
    });
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

    // Apply collision constraints
    constrainEntity(player);
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
    radius: p.radius,
    lastProcessedInput: p.lastProcessedInput,
    username: p.username,
    color: p.color
  }));
  if (snapshot.length) {
    // mark snapshots as volatile so a slow client won't cause queued bursts of old snapshots
    io.volatile.emit('stateSnapshot', { 
      now: Date.now(), 
      players: snapshot,
      walls: walls
    });
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on http://localhost:${PORT}`);
  if (process.env.CLIENT_ORIGIN) console.log('CLIENT_ORIGIN =', process.env.CLIENT_ORIGIN);
});

// Initialize walls on startup
generateWalls();
