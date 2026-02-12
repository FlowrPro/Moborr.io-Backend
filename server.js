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

// ============ PETAL SYSTEM (Server-side) ============
const RARITY_MULTIPLIERS = {
  'Common': 1,
  'Uncommon': 3,
  'Rare': 9,
  'Legendary': 27,
  'Mythical': 81,
  'Godly': 243
};

const PETAL_CATEGORIES = {
  HEAL: 'heal',
  CONSUMABLE: 'consumable',
  DAMAGER: 'damager',
  SHOOTABLE: 'shootable',
  BUFF: 'buff'
};

// ALL PETALS - Add new petals here!
const PETALS = {
  // ============ HEAL CATEGORY ============
  // Add HEAL petals here

  // ============ CONSUMABLE CATEGORY ============
  // Add CONSUMABLE petals here

  // ============ DAMAGER CATEGORY ============
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    category: PETAL_CATEGORIES.DAMAGER,
    icon: '/assets/petals/fireball.webp',
    description: 'A burning projectile that explodes on impact',
    damage: 30,
    health: 35
  },
  // Add more DAMAGER petals here

  // ============ SHOOTABLE CATEGORY ============
  // Add SHOOTABLE petals here

  // ============ BUFF CATEGORY ============
  // Add BUFF petals here
};

// Create a petal instance with rarity
function createPetal(petalId, rarity = 'Common') {
  const petalDef = PETALS[petalId];
  if (!petalDef) {
    console.error('Petal not found:', petalId);
    return null;
  }

  if (!RARITY_MULTIPLIERS[rarity]) {
    console.error('Invalid rarity:', rarity);
    return null;
  }

  const multiplier = RARITY_MULTIPLIERS[rarity];

  const petal = {
    instanceId: Math.random().toString(36).substr(2, 9),
    id: petalId,
    name: petalDef.name,
    category: petalDef.category,
    rarity: rarity,
    icon: petalDef.icon,
    description: petalDef.description,
    quantity: 1,
    
    healing: petalDef.healing ? petalDef.healing * multiplier : undefined,
    damage: petalDef.damage ? petalDef.damage * multiplier : undefined,
    health: petalDef.health ? petalDef.health * multiplier : undefined,
    speedMultiplier: petalDef.speedMultiplier ? petalDef.speedMultiplier * multiplier : undefined,
    defenseMultiplier: petalDef.defenseMultiplier,
    fireRate: petalDef.fireRate,
    duration: petalDef.duration,
    
    createdAt: Date.now(),
    cooldown: 0
  };

  return petal;
}

function createStartingInventory() {
  return [
    createPetal('fireball', 'Common'),
    createPetal('fireball', 'Uncommon'),
    createPetal('fireball', 'Rare'),
    createPetal('fireball', 'Legendary')
  ];
}

// ============ END PETAL SYSTEM ============

// Simulation parameters
const TICK_RATE = 30;
const MAX_INPUT_DT = 0.1;
const SPEED = 260;
const MAP_BOUNDS = { w: 12000, h: 12000, padding: 16 };

// Wall system (must match client)
const WALLS = [];

function generateMazeWalls() {
  const wallThickness = 600;
  const mapW = MAP_BOUNDS.w;
  const mapH = MAP_BOUNDS.h;
  
  WALLS.push({
    x: 0,
    y: 0,
    width: wallThickness,
    height: mapH * 0.4
  });
  
  WALLS.push({
    x: 0,
    y: 0,
    width: mapW * 0.35,
    height: wallThickness
  });
  
  WALLS.push({
    x: mapW * 0.3,
    y: wallThickness,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  WALLS.push({
    x: 0,
    y: mapH * 0.35,
    width: mapW * 0.25,
    height: wallThickness
  });
  
  WALLS.push({
    x: mapW * 0.45,
    y: mapH * 0.2,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  WALLS.push({
    x: mapW * 0.65,
    y: 0,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  WALLS.push({
    x: mapW * 0.7,
    y: mapH * 0.45,
    width: mapW * 0.3,
    height: wallThickness
  });
  
  WALLS.push({
    x: 0,
    y: mapH * 0.8,
    width: mapW * 0.6,
    height: wallThickness
  });
  
  WALLS.push({
    x: mapW * 0.55,
    y: mapH * 0.65,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  WALLS.push({
    x: mapW * 0.2,
    y: mapH * 0.5,
    width: mapW * 0.2,
    height: wallThickness
  });
  
  WALLS.push({
    x: mapW * 0.1,
    y: mapH * 0.5,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  WALLS.push({
    x: mapW * 0.75,
    y: mapH * 0.6,
    width: wallThickness,
    height: mapH * 0.2
  });
  
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  WALLS.push({
    x: mapW * 0.8,
    y: mapH * 0.15,
    width: mapW * 0.2,
    height: wallThickness
  });
}

// Simple spatial grid for collision optimization
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }
  
  getNearbyWalls(x, y, radius) {
    const nearbyWalls = new Set();
    const searchRadius = Math.ceil(radius / this.cellSize) + 1;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const wallsInCell = this.grid.get(key);
        if (wallsInCell) {
          wallsInCell.forEach(w => nearbyWalls.add(w));
        }
      }
    }
    
    return Array.from(nearbyWalls);
  }
  
  build(walls) {
    this.grid.clear();
    for (const wall of walls) {
      const minCellX = Math.floor(wall.x / this.cellSize);
      const minCellY = Math.floor(wall.y / this.cellSize);
      const maxCellX = Math.floor((wall.x + wall.width) / this.cellSize);
      const maxCellY = Math.floor((wall.y + wall.height) / this.cellSize);
      
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        for (let cy = minCellY; cy <= maxCellY; cy++) {
          const key = `${cx},${cy}`;
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key).push(wall);
        }
      }
    }
  }
}

const wallGrid = new SpatialGrid(1000);

function checkWallCollisionOptimized(x, y, radius) {
  const nearbyWalls = wallGrid.getNearbyWalls(x, y, radius);
  for (const wall of nearbyWalls) {
    const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.width));
    const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.height));
    
    const distX = x - closestX;
    const distY = y - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    
    if (distance < radius) {
      return true;
    }
  }
  return false;
}

const players = new Map();
const PLAYER_RADIUS = 26;

function findTopLeftSpawn() {
  const spawnSearchArea = {
    minX: 750,
    maxX: 1200,
    minY: 750,
    maxY: 1200
  };
  
  const gridStep = 50;
  
  for (let y = spawnSearchArea.minY; y <= spawnSearchArea.maxY; y += gridStep) {
    for (let x = spawnSearchArea.minX; x <= spawnSearchArea.maxX; x += gridStep) {
      if (!checkWallCollisionOptimized(x, y, PLAYER_RADIUS + 50)) {
        const offsetX = (Math.random() - 0.5) * 80;
        const offsetY = (Math.random() - 0.5) * 80;
        const finalX = x + offsetX;
        const finalY = y + offsetY;
        
        if (!checkWallCollisionOptimized(finalX, finalY, PLAYER_RADIUS)) {
          return { x: finalX, y: finalY };
        }
      }
    }
  }
  
  return { x: 800, y: 800 };
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 75% 50%)`;
}

function clamp(val, a, b) {
  return Math.max(a, Math.min(b, val));
}

generateMazeWalls();
wallGrid.build(WALLS);

const STALE_PLAYER_TIMEOUT = 30000;

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', (username) => {
    try {
      const spawn = findTopLeftSpawn();
      const p = {
        id: socket.id,
        username: String(username).slice(0, 20) || 'Player',
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        color: randomColor(),
        lastProcessedInput: 0,
        lastHeard: Date.now(),
        inventory: createStartingInventory(),
        hotbar: new Array(8).fill(null)
      };
      players.set(socket.id, p);

      socket.emit('currentPlayers', Array.from(players.values()).map(pl => ({
        id: pl.id,
        username: pl.username,
        x: pl.x,
        y: pl.y,
        vx: pl.vx,
        vy: pl.vy,
        color: pl.color
      })));
      
      socket.broadcast.emit('newPlayer', {
        id: p.id,
        username: p.username,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        color: p.color
      });
      
      socket.emit('playerInventory', {
        inventory: p.inventory,
        hotbar: p.hotbar
      });
      
      console.log('player joined', p.username, 'spawn', spawn);
    } catch (err) {
      console.error('Error in join event', err);
    }
  });

  socket.on('input', (msg) => {
    try {
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

      player.vx = ix * SPEED;
      player.vy = iy * SPEED;
      
      const newX = player.x + player.vx * dt;
      const newY = player.y + player.vy * dt;
      
      if (!checkWallCollisionOptimized(newX, newY, PLAYER_RADIUS)) {
        player.x = newX;
        player.y = newY;
      }

      player.x = clamp(player.x, MAP_BOUNDS.padding, MAP_BOUNDS.w - MAP_BOUNDS.padding);
      player.y = clamp(player.y, MAP_BOUNDS.padding, MAP_BOUNDS.h - MAP_BOUNDS.padding);
    } catch (err) {
      console.error('Error processing input', err);
    }
  });

  socket.on('equipPetal', (data) => {
    try {
      const player = players.get(socket.id);
      if (!player) return;

      const { petalInstanceId, hotbarSlot } = data;
      if (hotbarSlot < 0 || hotbarSlot >= 8) return;

      const petal = player.inventory.find(p => p.instanceId === petalInstanceId);
      if (!petal) return;

      player.hotbar[hotbarSlot] = petal;
      
      socket.emit('playerInventory', {
        inventory: player.inventory,
        hotbar: player.hotbar
      });
      
      console.log(`Player ${player.username} equipped ${petal.name} to hotbar slot ${hotbarSlot}`);
    } catch (err) {
      console.error('Error equipping petal', err);
    }
  });

  socket.on('usePetal', (data) => {
    try {
      const player = players.get(socket.id);
      if (!player) return;

      const { hotbarSlot } = data;
      if (hotbarSlot < 0 || hotbarSlot >= 8) return;

      const petal = player.hotbar[hotbarSlot];
      if (!petal) return;

      console.log(`Player ${player.username} used petal: ${petal.name}`);
    } catch (err) {
      console.error('Error using petal', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    if (players.has(socket.id)) {
      players.delete(socket.id);
      socket.broadcast.emit('playerLeft', socket.id);
    }
  });
});

setInterval(() => {
  try {
    const now = Date.now();
    const staleIds = [];

    for (const [id, p] of players) {
      if (now - p.lastHeard > STALE_PLAYER_TIMEOUT) {
        staleIds.push(id);
      }
    }

    staleIds.forEach(id => {
      players.delete(id);
      io.emit('playerLeft', id);
      console.log('Removed stale player', id);
    });

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
  } catch (err) {
    console.error('Error broadcasting snapshot', err);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Moborr.io server listening on http://localhost:${PORT}`);
  if (process.env.CLIENT_ORIGIN) console.log('CLIENT_ORIGIN =', process.env.CLIENT_ORIGIN);
});
