// Moborr.io server — authoritative movement with polygon-based maze walls
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

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
const TICK_RATE = 30;
const MAX_INPUT_DT = 0.1;
const SPEED = 260;

// Map with maze walls (12x12 grid)
const MAP_SIZE = 18000; // total size
const MAP_HALF = MAP_SIZE / 2;
const MAP_BOUNDS = { w: MAP_SIZE, h: MAP_SIZE, padding: 300 };

// Grid maze generation
const CELL = MAP_SIZE / 12;
const WALL_THICKNESS = 672;
const GAP = Math.floor(Math.max(24, CELL * 0.05));

function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

function gridToWorldCenter(col, row) {
  const x = -MAP_HALF + (col - 0.5) * CELL;
  const y = -MAP_HALF + (row - 0.5) * CELL;
  return { x, y };
}

// Centerline path following the maze
const centerlineGrid = [
  [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
  [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
  [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
];

const centerline = centerlineGrid.map(([c, r]) => gridToWorldCenter(c, r));

// Convert polyline to thick polygon
function polylineToThickPolygon(points, thickness) {
  if (!points || points.length < 2) return [];
  const half = thickness / 2;
  const left = [];
  const right = [];
  const normals = [];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dir = normalize(b.x - a.x, b.y - a.y);
    normals.push({ x: -dir.y, y: dir.x });
  }

  for (let i = 0; i < points.length; i++) {
    let n = { x: 0, y: 0 };
    if (i === 0) n = normals[0] || { x: 0, y: 1 };
    else if (i === points.length - 1) n = normals[normals.length - 1] || { x: 0, y: 1 };
    else {
      n.x = (normals[i - 1] ? normals[i - 1].x : 0) + (normals[i] ? normals[i].x : 0);
      n.y = (normals[i - 1] ? normals[i - 1].y : 0) + (normals[i] ? normals[i].y : 0);
      const nl = Math.hypot(n.x, n.y);
      if (nl < 1e-4) n = normals[i] || { x: 0, y: 1 };
      else { n.x /= nl; n.y /= nl; }
    }
    left.push({ x: points[i].x + n.x * half, y: points[i].y + n.y * half });
    right.push({ x: points[i].x - n.x * half, y: points[i].y - n.y * half });
  }

  return left.concat(right.reverse());
}

// Generate maze walls
function generateMazeWalls() {
  const walls = [];
  
  // Main centerline passage
  const passageWall = polylineToThickPolygon(centerline, WALL_THICKNESS);
  walls.push({ id: 'passage', points: passageWall });

  // Grid walls (outer perimeter and grid lines)
  for (let col = 0; col <= 12; col++) {
    for (let row = 0; row <= 12; row++) {
      const cellKey = `${col}-${row}`;
      const isCenterlineCell = centerlineGrid.some(([c, r]) => c === col && r === row);
      
      if (isCenterlineCell) continue; // Skip cells on the main path

      // Add outer walls of the cell
      const x = -MAP_HALF + col * CELL;
      const y = -MAP_HALF + row * CELL;

      if (col === 0 || col === 12) {
        // Outer perimeter
        walls.push({
          id: `wall-perimeter-${cellKey}`,
          x: x,
          y: y,
          w: CELL,
          h: CELL
        });
      } else if (row === 0 || row === 12) {
        // Outer perimeter
        walls.push({
          id: `wall-perimeter-${cellKey}`,
          x: x,
          y: y,
          w: CELL,
          h: CELL
        });
      }
    }
  }

  return walls;
}

const MAZE_WALLS = generateMazeWalls();

function randomSpawn() {
  // Spawn players near the start of the maze (around cell 2,1)
  const spawnCell = gridToWorldCenter(2, 1);
  const offset = CELL * 0.3;
  return {
    x: spawnCell.x + (Math.random() - 0.5) * offset,
    y: spawnCell.y + (Math.random() - 0.5) * offset
  };
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 75% 50%)`;
}

function clamp(val, a, b) {
  return Math.max(a, Math.min(b, val));
}

const players = new Map();

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

    // Send initial state with maze walls
    socket.emit('currentPlayers', Array.from(players.values()));
    socket.emit('mazeWalls', MAZE_WALLS);
    
    socket.broadcast.emit('newPlayer', p);
    console.log('player joined', p.username, 'at', spawn);
  });

  socket.on('input', (msg) => {
    const player = players.get(socket.id);
    if (!player) return;

    const now = Date.now();
    player.lastHeard = now;

    const seq = Number(msg.seq) || 0;
    let dt = Number(msg.dt) || (1 / TICK_RATE);
    dt = Math.min(dt, MAX_INPUT_DT);

    if (seq <= player.lastProcessedInput) return;
    player.lastProcessedInput = seq;

    const input = msg.input || { x: 0, y: 0 };
    let ix = Number(input.x) || 0;
    let iy = Number(input.y) || 0;
    const len = Math.hypot(ix, iy);
    if (len > 1e-6) { ix /= len; iy /= len; }

    // Apply movement
    player.vx = ix * SPEED;
    player.vy = iy * SPEED;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // Clamp to map bounds
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

// Broadcast snapshots
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
});
