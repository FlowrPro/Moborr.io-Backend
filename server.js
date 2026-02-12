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
const MAP_CENTER = { x: 0, y: 0 };
const MAP_HALF = 6000;

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

// --- Wall Generation (Single Snake Maze) ---
// Creates a continuous snake-like wall that winds through the map
function generateSnakeMaze() {
  const CELL = 1000; // Grid cell size (12 cells across = 12000)
  const WALL_THICKNESS = 200; // Thickness of wall segments
  const COLS = 12;
  const ROWS = 12;
  
  const centerX = MAP_CENTER.x;
  const centerY = MAP_CENTER.y;
  const halfW = MAP_HALF - MAP_BOUNDS.padding;
  const halfH = MAP_HALF - MAP_BOUNDS.padding;
  
  // Define a snake path through the grid (alternating rows, moving horizontally and vertically)
  const snakePath = [];
  
  // Create a winding path that goes:
  // Right across row 1, down to row 2, left across row 2, down to row 3, right across row 3, etc.
  for (let row = 1; row < ROWS; row++) {
    const isLeftToRight = row % 2 === 1;
    
    if (isLeftToRight) {
      // Go left to right
      for (let col = 1; col < COLS; col++) {
        const x1 = centerX + (col - COLS/2) * CELL;
        const y1 = centerY + (row - ROWS/2) * CELL;
        const x2 = centerX + ((col + 1) - COLS/2) * CELL;
        const y2 = centerY + (row - ROWS/2) * CELL;
        snakePath.push([x1, y1, x2, y2]);
      }
    } else {
      // Go right to left
      for (let col = COLS - 1; col > 1; col--) {
        const x1 = centerX + (col - COLS/2) * CELL;
        const y1 = centerY + (row - ROWS/2) * CELL;
        const x2 = centerX + ((col - 1) - COLS/2) * CELL;
        const y2 = centerY + (row - ROWS/2) * CELL;
        snakePath.push([x1, y1, x2, y2]);
      }
    }
    
    // Add vertical segment to next row
    if (row < ROWS - 1) {
      const col = isLeftToRight ? COLS - 1 : 1;
      const x = centerX + (col - COLS/2) * CELL;
      const y1 = centerY + (row - ROWS/2) * CELL;
      const y2 = centerY + ((row + 1) - ROWS/2) * CELL;
      snakePath.push([x, y1, x, y2]);
    }
  }
  
  // Convert line segments to thick rectangles (wall polygons)
  const walls = [];
  let wallId = 0;
  
  for (const [x1, y1, x2, y2] of snakePath) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    
    if (len < 1) continue;
    
    const nx = -dy / len;
    const ny = dx / len;
    
    const half = WALL_THICKNESS / 2;
    
    // Create rectangle corners for this wall segment
    const x1_offset = x1 + nx * half;
    const y1_offset = y1 + ny * half;
    const x2_offset = x2 + nx * half;
    const y2_offset = y2 + ny * half;
    const x3_offset = x2 - nx * half;
    const y3_offset = y2 - ny * half;
    const x4_offset = x1 - nx * half;
    const y4_offset = y1 - ny * half;
    
    // Clamp all points to map bounds
    const points = [
      { x: clamp(x1_offset, centerX - halfW, centerX + halfW), y: clamp(y1_offset, centerY - halfH, centerY + halfH) },
      { x: clamp(x2_offset, centerX - halfW, centerX + halfW), y: clamp(y2_offset, centerY - halfH, centerY + halfH) },
      { x: clamp(x3_offset, centerX - halfW, centerX + halfW), y: clamp(y3_offset, centerY - halfH, centerY + halfH) },
      { x: clamp(x4_offset, centerX - halfW, centerX + halfW), y: clamp(y4_offset, centerY - halfH, centerY + halfH) }
    ];
    
    walls.push({
      id: `wall_${wallId++}`,
      points: points
    });
  }
  
  return walls;
}

const walls = generateSnakeMaze();

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

    // send initial state with walls
    socket.emit('currentPlayers', Array.from(players.values()), walls);
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
    // Include walls in snapshot for new players or updates
    io.volatile.emit('stateSnapshot', { now: Date.now(), players: snapshot, walls: walls });
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on http://localhost:${PORT}`);
  if (process.env.CLIENT_ORIGIN) console.log('CLIENT_ORIGIN =', process.env.CLIENT_ORIGIN);
});
