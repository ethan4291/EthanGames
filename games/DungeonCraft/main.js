'use strict';
// textures & blocks
const TEX_NAMES = ['stonetexture', 'mossy_bricks', 'cracked_bricks', 'floor_tiles', 'chiseled_stone',
  'planks', 'torch', 'iron_bars', 'gold_ore', 'lava'];
const T = {};
TEX_NAMES.forEach((n, i) => (T[n] = i));

const AIR = 0, STONE = 1, MOSSY = 2, CRACKED = 3, TILES = 4, CHISELED = 5, PLANKS = 6,
  TORCH = 7, BARS = 8, GOLD = 9, LAVA = 10, EXIT = 11;
const DEF = [];
function def(id, o) {
  DEF[id] = Object.assign({ shape: 'cube', opaque: true, solid: true, light: 0, tex: 0, sound: 'stone' }, o);
}
def(AIR, { shape: 'none', opaque: false, solid: false });
def(STONE, { tex: T.stonetexture });
def(MOSSY, { tex: T.mossy_bricks });
def(CRACKED, { tex: T.cracked_bricks });
def(TILES, { tex: T.floor_tiles });
def(CHISELED, { tex: T.chiseled_stone });
def(PLANKS, { tex: T.planks, sound: 'wood' });
def(TORCH, { shape: 'torch', opaque: false, solid: false, light: 14, tex: T.torch, sound: 'wood' });
def(BARS, { shape: 'bars', opaque: false, tex: T.iron_bars, sound: 'metal' });
def(GOLD, { tex: T.gold_ore });
def(LAVA, { shape: 'lava', opaque: false, solid: false, light: 13, tex: T.lava });
def(EXIT, { shape: 'none', opaque: false, solid: false, light: 15 }); // the portal's light; drawn as an entity

// text (all of it lives in text.json)
let TEXT = null;
const fmt = (str, vars = {}) => str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
async function loadText() {
  const r = await fetch('text.json');
  if (!r.ok) throw new Error('text.json');
  TEXT = await r.json();
}

// random
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// ?seed=N repeats a run, ?level=N starts on floor N (1-5)
const params = new URLSearchParams(location.search);
const BASE_SEED = params.has('seed') ? (parseInt(params.get('seed'), 10) || 1) : ((Math.random() * 1e9) | 0);
let SEED = BASE_SEED, rand = mulberry32(SEED);
function reseed(s) { SEED = s | 0; rand = mulberry32(SEED); }
const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = arr => arr[Math.floor(rand() * arr.length)];

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = t => t * t * (3 - 2 * t);
  const fx = s(x - xi), fy = s(y - yi), fz = s(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}

// world storage
const WX = 80, WY = 16, WZ = 80, CS = 16;
const CX = WX / CS, CY = WY / CS, CZ = WZ / CS;
const N = WX * WY * WZ;
const blocks = new Uint8Array(N);
const meta = new Uint8Array(N);
const light = new Uint8Array(N);
const idx = (x, y, z) => (y * WZ + z) * WX + x;
const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < WX && y < WY && z < WZ;
const getB = (x, y, z) => (inside(x, y, z) ? blocks[idx(x, y, z)] : STONE);
const getL = (x, y, z) => (inside(x, y, z) ? light[idx(x, y, z)] : 0);
const opaqueAt = (x, y, z) => DEF[getB(x, y, z)].opaque;
function setRaw(x, y, z, id, m = 0) {
  if (!inside(x, y, z)) return;
  const i = idx(x, y, z);
  blocks[i] = id; meta[i] = m;
}

// direction metadata (used by wall torches = direction TO the wall)
const DIRS = [null, [1, 0], [-1, 0], [0, 1], [0, -1]]; // 1:+X 2:-X 3:+Z 4:-Z
const dirMeta = (dx, dz) => (dx > 0 ? 1 : dx < 0 ? 2 : dz > 0 ? 3 : 4);

let gold = 0;
let spawn = { x: 40.5, y: 4, z: 40.5 };
let healthSpots = []; // [x, z] cells where a health crystal floats when the floor starts

// the twenty floors
// mix: the share of each creature on the floor. Every kind listed is guaranteed to appear at least once (see
// rosterFor), so even the first floor has three kinds. Each floor leans on a different few, so no two feel the same.
// Every floor is one storey of rooms; the last ends in the Ember Lord's arena.
const LEVELS = [
  { rooms: 5, enemies: 7, mix: [['ghoul', 0.55], ['bat', 0.3], ['bloater', 0.15]], dark: 0.1 },
  { rooms: 5, enemies: 9, mix: [['ghoul', 0.4], ['bat', 0.25], ['cultist', 0.2], ['bloater', 0.15]], dark: 0.1 },
  { rooms: 6, enemies: 11, mix: [['ghoul', 0.3], ['cultist', 0.2], ['spitter', 0.2], ['bat', 0.15], ['bloater', 0.15]], dark: 0.15 },
  { rooms: 6, enemies: 12, mix: [['ghoul', 0.25], ['warden', 0.2], ['spitter', 0.2], ['cultist', 0.15], ['bat', 0.1], ['bloater', 0.1]], dark: 0.15 },
  { rooms: 7, enemies: 14, mix: [['ghoul', 0.2], ['brute', 0.15], ['warden', 0.15], ['cultist', 0.15], ['spitter', 0.15], ['bat', 0.1], ['bloater', 0.1]], dark: 0.2 },
  { rooms: 7, enemies: 14, mix: [['ghoul', 0.25], ['gorehorn', 0.2], ['bat', 0.2], ['bloater', 0.15], ['spitter', 0.1], ['cultist', 0.1]], dark: 0.25 },
  { rooms: 7, enemies: 15, mix: [['bat', 0.3], ['ghoul', 0.2], ['gorehorn', 0.15], ['bloater', 0.15], ['spitter', 0.1], ['brute', 0.1]], dark: 0.4 },
  { rooms: 8, enemies: 16, mix: [['warden', 0.2], ['ghoul', 0.2], ['cultist', 0.15], ['brute', 0.15], ['gorehorn', 0.1], ['spitter', 0.1], ['bat', 0.1]], dark: 0.25 },
  { rooms: 8, enemies: 16, mix: [['shade', 0.25], ['cultist', 0.2], ['ghoul', 0.2], ['bat', 0.15], ['warden', 0.1], ['bloater', 0.1]], dark: 0.35 },
  { rooms: 8, enemies: 17, mix: [['brute', 0.2], ['warden', 0.2], ['shade', 0.15], ['gorehorn', 0.15], ['spitter', 0.15], ['bloater', 0.15]], dark: 0.25 },
  { rooms: 9, enemies: 18, mix: [['shade', 0.2], ['ghoul', 0.2], ['bat', 0.2], ['spitter', 0.15], ['cultist', 0.15], ['bloater', 0.1]], dark: 0.45 },
  { rooms: 9, enemies: 18, mix: [['ghoul', 0.3], ['gravecaller', 0.15], ['cultist', 0.15], ['warden', 0.15], ['shade', 0.15], ['bat', 0.1]], dark: 0.3 },
  { rooms: 9, enemies: 19, mix: [['gorehorn', 0.25], ['brute', 0.2], ['bloater', 0.2], ['spitter', 0.15], ['bat', 0.1], ['warden', 0.1]], dark: 0.3 },
  { rooms: 10, enemies: 20, mix: [['shade', 0.2], ['cultist', 0.2], ['ghoul', 0.2], ['gravecaller', 0.15], ['bat', 0.15], ['bloater', 0.1]], dark: 0.4 },
  { rooms: 10, enemies: 21, mix: [['warden', 0.2], ['gorehorn', 0.2], ['brute', 0.15], ['spitter', 0.15], ['gravecaller', 0.1], ['cultist', 0.1], ['shade', 0.1]], dark: 0.3 },
  { rooms: 10, enemies: 22, mix: [['spitter', 0.2], ['bloater', 0.2], ['bat', 0.2], ['gorehorn', 0.15], ['shade', 0.15], ['ghoul', 0.1]], dark: 0.35 },
  { rooms: 10, enemies: 23, mix: [['shade', 0.2], ['gravecaller', 0.15], ['warden', 0.15], ['brute', 0.15], ['cultist', 0.15], ['bat', 0.1], ['ghoul', 0.1]], dark: 0.45 },
  { rooms: 11, enemies: 24, mix: [['brute', 0.2], ['gorehorn', 0.2], ['warden', 0.15], ['spitter', 0.15], ['bloater', 0.1], ['shade', 0.1], ['gravecaller', 0.1]], dark: 0.35 },
  { rooms: 11, enemies: 26, mix: [['warden', 0.15], ['brute', 0.15], ['ghoul', 0.1], ['bat', 0.1], ['bloater', 0.1], ['cultist', 0.1], ['spitter', 0.1], ['gorehorn', 0.1], ['shade', 0.05], ['gravecaller', 0.05]], dark: 0.4 },
  { rooms: 7, enemies: 14, mix: [['ghoul', 0.2], ['cultist', 0.15], ['warden', 0.15], ['shade', 0.15], ['gorehorn', 0.1], ['bat', 0.1], ['spitter', 0.1], ['bloater', 0.05]], dark: 0.2, boss: true },
];
const START_LEVEL = Math.max(0, Math.min(LEVELS.length - 1, (parseInt(params.get('level'), 10) || 1) - 1));
const MAX_HP = 100;
const GUN = { dmg: 34, rate: 0.17, mag: 12, reload: 1.15, range: 64 };

// dungeon generator
const FY = 3; // floor height of every room
let rooms = [], spawnRoom = null, exitRoom = null, exitPos = null;

function carve(x0, y0, z0, x1, y1, z1) {
  for (let y = Math.max(1, y0); y <= Math.min(WY - 2, y1); y++)
    for (let z = Math.max(1, z0); z <= Math.min(WZ - 2, z1); z++)
      for (let x = Math.max(1, x0); x <= Math.min(WX - 2, x1); x++) setRaw(x, y, z, AIR);
}

// returns false if the exit can't be reached from the spawn (the caller then rerolls)
function generateDungeon(cfg) {
  blocks.fill(STONE); meta.fill(0);
  rooms = [];
  const fy = FY;
  // the first room is the exit room: always roomy, and a big arena on the boss floor
  for (let t = 0; t < 800 && rooms.length < cfg.rooms; t++) {
    const first = !rooms.length;
    const w = first ? (cfg.boss ? 17 : ri(11, 13)) : ri(7, 14);
    const d = first ? (cfg.boss ? 17 : ri(11, 13)) : ri(7, 14);
    const h = first ? (cfg.boss ? 9 : ri(6, 8)) : ri(5, 8);
    const x = ri(3, WX - 4 - w), z = ri(3, WZ - 4 - d);
    if (rooms.some(r => x < r.x + r.w + 4 && x + w + 4 > r.x && z < r.z + r.d + 4 && z + d + 4 > r.z)) continue;
    rooms.push({ x, z, w, d, h, fy, cx: x + (w >> 1), cz: z + (d >> 1) });
  }
  if (rooms.length < 3) return false;
  for (const r of rooms) {
    carve(r.x, fy + 1, r.z, r.x + r.w - 1, fy + r.h, r.z + r.d - 1);
    for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) {
      setRaw(x, fy, z, TILES);
      // vaulted ceiling: the top two rows step in from the walls, and the bevels round the steps off
      const e = Math.min(x - r.x, r.x + r.w - 1 - x, z - r.z, r.z + r.d - 1 - z);
      if (e === 0) setRaw(x, fy + r.h - 1, z, STONE);
      if (e <= 1) setRaw(x, fy + r.h, z, STONE);
    }
  }

  // you start in the room farthest from the exit
  exitRoom = rooms[0];
  const far = r => Math.hypot(r.cx - exitRoom.cx, r.cz - exitRoom.cz);
  spawnRoom = rooms.slice(1).reduce((a, r) => (far(r) > far(a) ? r : a));
  for (const r of rooms) {
    const special = r === spawnRoom || r === exitRoom;
    r.dark = !special && rand() < cfg.dark;
    const roll = rand();
    r.kind = r === spawnRoom ? 'plain'
      : r === exitRoom ? 'pillars'
      : roll < 0.2 && r.w >= 11 && r.d >= 11 ? 'pillars'
      : roll < 0.4 && r.w >= 9 && r.d >= 9 ? 'lava'
      : roll < 0.55 && r.w >= 9 ? 'prison'
      : roll < 0.8 ? 'storage' : 'plain';
    // prison cells are built BEFORE corridors, so corridors smash through the bars and nothing gets cut off
    if (r.kind === 'prison') {
      for (let x = r.x; x < r.x + r.w; x++)
        for (let y = fy + 1; y <= fy + 3; y++) setRaw(x, y, r.z + 3, BARS);
      for (let x = r.x + 4; x < r.x + r.w - 1; x += 4)
        for (let z = r.z; z < r.z + 3; z++)
          for (let y = fy + 1; y <= fy + 3; y++) setRaw(x, y, z, BARS);
    }
  }

  const corridors = [];
  function corridor(x0, z0, x1, z1) {
    const path = [];
    let x = x0, z = z0;
    const stepTo = (tx, tz) => {
      while (x !== tx || z !== tz) {
        if (x !== tx) x += Math.sign(tx - x); else z += Math.sign(tz - z);
        path.push([x, z]);
      }
    };
    if (rand() < 0.5) { stepTo(x1, z0); stepTo(x1, z1); } else { stepTo(x0, z1); stepTo(x1, z1); }
    for (const [px, pz] of path) { // arched: full width up to head height, only the middle above that
      carve(px - 1, fy + 1, pz - 1, px + 1, fy + 3, pz + 1);
      carve(px, fy + 4, pz, px, fy + 4, pz);
    }
    corridors.push({ path });
  }
  const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cz - b.cz);
  const done = [rooms[0]], todo = rooms.slice(1);
  while (todo.length) {
    let best = null, bd = 1e9;
    for (const a of done) for (const b of todo) { const d = dist(a, b); if (d < bd) { bd = d; best = [a, b]; } }
    corridor(best[0].cx, best[0].cz, best[1].cx, best[1].cz);
    done.push(best[1]); todo.splice(todo.indexOf(best[1]), 1);
  }
  for (let k = 0; k < (rooms.length > 6 ? 2 : 1); k++) { // an extra loop or two so it isn't a pure tree
    const a = pick(rooms), b = pick(rooms);
    if (a !== b) corridor(a.cx, a.cz, b.cx, b.cz);
  }

  // ---- room features that must not be carved through
  for (const r of rooms) {
    if (r.kind === 'pillars') {
      const o = r.w >= 15 ? 3 : 2;
      for (const px of [r.x + o, r.x + r.w - 1 - o]) for (const pz of [r.z + o, r.z + r.d - 1 - o])
        for (let y = fy + 1; y <= fy + r.h; y++) setRaw(px, y, pz, CHISELED);
    } else if (r.kind === 'lava') {
      for (let z = r.z + 3; z <= r.z + r.d - 4; z++)
        for (let x = r.x + 3; x <= r.x + r.w - 4; x++) setRaw(x, fy, z, LAVA);
    } else if (r.kind === 'storage') {
      for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) setRaw(x, fy, z, PLANKS);
    }
  }

  // ---- the exit portal: a chiselled arch on a dais in the middle of the exit room
  const ex = exitRoom.cx, ez = exitRoom.cz;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) setRaw(ex + dx, fy, ez + dz, CHISELED);
  for (let y = fy + 1; y <= fy + 3; y++) {
    setRaw(ex - 1, y, ez, CHISELED); setRaw(ex + 1, y, ez, CHISELED); setRaw(ex, y, ez, AIR);
  }
  for (let dx = -1; dx <= 1; dx++) setRaw(ex + dx, fy + 4, ez, CHISELED);
  setRaw(ex, fy + 1, ez, EXIT);
  exitPos = [ex, ez];

  // ---- weather the walls: moss, cracks, gold veins
  for (let y = 1; y < WY - 1; y++)
    for (let z = 1; z < WZ - 1; z++)
      for (let x = 1; x < WX - 1; x++) {
        const i = idx(x, y, z);
        if (blocks[i] !== STONE) continue;
        if (!(blocks[i + 1] === AIR || blocks[i - 1] === AIR || blocks[i + WX] === AIR || blocks[i - WX] === AIR ||
          blocks[i + WX * WZ] === AIR || blocks[i - WX * WZ] === AIR)) continue;
        const n = vnoise(x / 5, y / 4, z / 5);
        if (n > 0.64 - cfg.dark * 0.15) blocks[i] = MOSSY;
        else if (hash3(x, y, z * 7) < 0.09) blocks[i] = CRACKED;
        else if (hash3(x * 3, y, z) < 0.025) blocks[i] = GOLD;
      }

  // ---- lighting fixtures
  const wallTorch = (x, y, z, dx, dz) => {
    if (getB(x, y, z) !== AIR || !opaqueAt(x + dx, y, z + dz)) return false;
    if (getB(x, y - 1, z) === AIR && getB(x, y - 2, z) === LAVA) return false;
    setRaw(x, y, z, TORCH, dirMeta(dx, dz));
    return true;
  };
  const perimeter = r => {
    const out = [];
    for (let x = r.x; x < r.x + r.w; x++) out.push([x, r.z, 0, -1], [x, r.z + r.d - 1, 0, 1]);
    for (let z = r.z + 1; z < r.z + r.d - 1; z++) out.push([r.x, z, -1, 0], [r.x + r.w - 1, z, 1, 0]);
    return out;
  };
  for (const r of rooms) {
    if (r.dark) continue;
    const per = perimeter(r);
    const step = r === spawnRoom || r === exitRoom ? 3 : 5;
    for (let k = ri(0, 2); k < per.length; k += step) {
      const [x, z, dx, dz] = per[k];
      wallTorch(x, fy + 3, z, dx, dz);
    }
    if (r.kind === 'pillars') {
      const o = r.w >= 15 ? 3 : 2;
      for (const px of [r.x + o, r.x + r.w - 1 - o]) for (const pz of [r.z + o, r.z + r.d - 1 - o]) {
        const dx = px < r.cx ? 1 : -1;
        wallTorch(px + dx, fy + 3, pz, -dx, 0);
      }
    }
  }
  for (const c of corridors) {
    for (let k = 4; k < c.path.length - 2; k += 9) {
      const [x, z] = c.path[k], [nx, nz] = c.path[k + 1];
      const ax = nz !== z ? 1 : 0, az = nx !== x ? 1 : 0; // perpendicular
      const s = rand() < 0.5 ? 1 : -1;
      if (!wallTorch(x + ax * s, fy + 3, z + az * s, ax * s, az * s))
        wallTorch(x - ax * s, fy + 3, z - az * s, -ax * s, -az * s);
    }
  }

  // ---- crates along the storeroom walls
  for (const r of rooms) {
    if (r.kind === 'storage')
      for (let n = 0; n < 7; n++) {
        const [x, z, dx, dz] = pick(perimeter(r));
        const y = fy + 1;
        if (getB(x, y, z) !== AIR || !opaqueAt(x + dx, y, z + dz) || !opaqueAt(x + dx, y + 1, z + dz)) continue;
        setRaw(x, y, z, PLANKS);
        if (rand() < 0.4) setRaw(x, y + 1, z, PLANKS);
      }
  }

  spawn = { x: spawnRoom.cx + 0.5, y: fy + 1, z: spawnRoom.cz + 0.5 };
  for (let y = fy + 1; y <= fy + 3; y++) setRaw(spawnRoom.cx, y, spawnRoom.cz, AIR);

  computeWalk();
  bfs(spawnRoom.cx, spawnRoom.cz, spawnDist);

  // ---- health crystals float in about half the rooms (more of them on the deeper floors)
  healthSpots = [];
  for (const r of rooms) {
    if (r === spawnRoom || r === exitRoom || rand() > 0.4 + cfg.rooms * 0.02) continue;
    for (let tries = 0; tries < 30; tries++) {
      const x = ri(r.x + 1, r.x + r.w - 2), z = ri(r.z + 1, r.z + r.d - 2);
      if (walk[z * WX + x] && spawnDist[z * WX + x] > 0) { healthSpots.push([x, z]); break; }
    }
  }
  return spawnDist[ez * WX + ex] > 0;
}

// walk grid & path fields
// every floor is one storey, so pathfinding is a 2D grid of "can a creature stand here" cells
const walk = new Uint8Array(WX * WZ), spawnDist = new Int16Array(WX * WZ), flow = new Int16Array(WX * WZ);
const bfsQ = new Int32Array(WX * WZ);
let flowCell = -1;
function computeWalk() {
  for (let z = 0; z < WZ; z++) for (let x = 0; x < WX; x++) {
    const f = getB(x, FY, z);
    walk[z * WX + x] = DEF[f].solid && f !== LAVA && !DEF[getB(x, FY + 1, z)].solid && !DEF[getB(x, FY + 2, z)].solid ? 1 : 0;
  }
}
const walkAt = (x, z) => { const cx = Math.floor(x), cz = Math.floor(z); return cx >= 0 && cz >= 0 && cx < WX && cz < WZ && walk[cz * WX + cx] === 1; };
function bfs(sx, sz, out) {
  out.fill(-1);
  const s = sz * WX + sx;
  if (!walk[s]) return out;
  let h = 0, t = 0;
  out[s] = 0; bfsQ[t++] = s;
  while (h < t) {
    const c = bfsQ[h++], x = c % WX, nd = out[c] + 1;
    if (x > 0 && walk[c - 1] && out[c - 1] < 0) { out[c - 1] = nd; bfsQ[t++] = c - 1; }
    if (x < WX - 1 && walk[c + 1] && out[c + 1] < 0) { out[c + 1] = nd; bfsQ[t++] = c + 1; }
    if (c >= WX && walk[c - WX] && out[c - WX] < 0) { out[c - WX] = nd; bfsQ[t++] = c - WX; }
    if (c < WX * (WZ - 1) && walk[c + WX] && out[c + WX] < 0) { out[c + WX] = nd; bfsQ[t++] = c + WX; }
  }
  return out;
}
// distance-to-player field; creatures walk downhill on it to find their way round walls
function updateFlow() {
  const c = Math.floor(P.z) * WX + Math.floor(P.x);
  if (c === flowCell || c < 0 || c >= WX * WZ || !walk[c]) return;
  flowCell = c;
  bfs(c % WX, (c / WX) | 0, flow);
}

// block light (flood fill)
function computeLight() {
  light.fill(0);
  const buckets = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < N; i++) {
    const e = DEF[blocks[i]].light;
    if (e) { light[i] = e; buckets[e].push(i); }
  }
  const SY = WX * WZ;
  for (let L = 15; L > 1; L--) {
    const b = buckets[L], nl = L - 1;
    for (let k = 0; k < b.length; k++) {
      const i = b[k];
      if (light[i] !== L) continue;
      const x = i % WX, z = ((i / WX) | 0) % WZ, y = (i / SY) | 0;
      const tryN = n => { if (light[n] < nl && !DEF[blocks[n]].opaque) { light[n] = nl; buckets[nl].push(n); } };
      if (x > 0) tryN(i - 1); if (x < WX - 1) tryN(i + 1);
      if (z > 0) tryN(i - WX); if (z < WZ - 1) tryN(i + WX);
      if (y > 0) tryN(i - SY); if (y < WY - 1) tryN(i + SY);
    }
  }
}

// math
const M4 = {
  persp(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  // camera basis (right, up, forward) for a yaw / pitch / roll
  basis(yaw, pitch, roll = 0) {
    const cp = Math.cos(pitch);
    const f = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
    let r = [Math.cos(yaw), 0, -Math.sin(yaw)];
    let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      [r, u] = [[0, 1, 2].map(a => r[a] * c + u[a] * s), [0, 1, 2].map(a => u[a] * c - r[a] * s)];
    }
    return { r, u, f };
  },
  view(e, yaw, pitch, roll = 0) {
    const { r, u, f } = M4.basis(yaw, pitch, roll);
    const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -d(r, e), -d(u, e), d(f, e), 1]);
  },
};
// small affine transforms for posing creature parts: [3x3 row-major, tx, ty, tz]
const XF = {
  id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  t: (x, y, z) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z],
  s: k => [k, 0, 0, 0, k, 0, 0, 0, k, 0, 0, 0],
  rx(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c, 0, 0, 0]; },
  ry(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c, 0, 0, 0]; },
  rz(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1, 0, 0, 0]; },
  mul(a, b) { // a after b
    const o = new Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      o[9 + r] = a[r * 3] * b[9] + a[r * 3 + 1] * b[10] + a[r * 3 + 2] * b[11] + a[9 + r];
    }
    return o;
  },
  chain(...ms) { return ms.reduce((a, b) => XF.mul(a, b)); },
};
const xfApply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11]];
const xfDir = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function turnTo(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}

// WebGL setup
const canvas = document.getElementById('game');
const gl = canvas.getContext('webgl2', { antialias: false });
const statusEl = document.getElementById('status');

function compile(vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

// shared by the block and creature shaders: up to 8 moving point lights (fireballs, muzzle flash, portal),
// and the final grade (highlight shoulder, cool shadows, fog, vignette, dither)
const SHADER_COMMON = `
uniform vec2 uRes;
uniform vec4 uPts[8]; uniform vec3 uPtC[8]; uniform int uPtsN;
const vec3 FOG = vec3(0.016, 0.012, 0.018);
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 pointLights(vec3 P, vec3 N){
  vec3 s = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    if (k >= uPtsN) break;
    vec3 Ld = uPts[k].xyz - P; float dd = length(Ld); Ld /= max(dd, 1e-4);
    float a = uPts[k].w / (1.0 + dd * dd * 0.4) * (1.0 - smoothstep(5.0, 10.0, dd));
    s += uPtC[k] * a * (max(dot(N, Ld), 0.0) * 0.85 + 0.15);
  }
  return s;
}
vec3 grade(vec3 col, float d){
  col *= 1.25;
  col = col * (1.0 + col * 0.25) / (1.0 + col);
  col = mix(col, col * vec3(0.82, 0.92, 1.18), (1.0 - smoothstep(0.0, 0.2, lum(col))) * 0.7);
  float fog = 1.0 - exp(-pow(d / 30.0, 2.0));
  col = mix(col, FOG, clamp(fog, 0.0, 1.0));
  vec2 sp = gl_FragCoord.xy / uRes - 0.5; sp.x *= uRes.x / uRes.y;
  col *= 1.0 - smoothstep(0.35, 1.0, length(sp)) * 0.6;
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  return col;
}`;

const BLOCK_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aUVL;
layout(location=2) in vec2 aLS;
uniform mat4 uMVP;
out vec3 vUVL; out vec2 vLS; out vec3 vPos;
void main(){ vUVL=aUVL; vLS=aLS; vPos=aPos; gl_Position=uMVP*vec4(aPos,1.0); }`;

const BLOCK_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform vec3 uCam; uniform vec3 uLamp; uniform float uTime; uniform float uLava; uniform float uTorch;
${SHADER_COMMON}
in vec3 vUVL; in vec2 vLS; in vec3 vPos;
out vec4 outColor;
void main(){
  float layer = vUVL.z;
  bool lava = abs(layer - uLava) < 0.5;
  vec2 uv = vUVL.xy;
  if (lava) { uv.y += uTime * 0.035; uv.x += sin(uTime * 0.6 + vPos.z * 0.3) * 0.04; }

  // surface frame from screen-space derivatives (must be taken before any discard)
  vec3 dp1 = dFdx(vPos), dp2 = dFdy(vPos);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 N = normalize(cross(dp1, dp2));                  // always faces the viewer
  vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
  vec3 Tg = p2 * duv1.x + p1 * duv2.x, Bg = p2 * duv1.y + p1 * duv2.y;
  float im = inversesqrt(max(max(dot(Tg, Tg), dot(Bg, Bg)), 1e-12));

  vec4 t = texture(uTex, vec3(uv, layer));
  if (t.a < 0.4) discard;

  // relief: read texel brightness as height, so mortar lines and cracks sink into the surface
  float h0 = lum(t.rgb);
  float hu = lum(texture(uTex, vec3(uv + vec2(1.0 / 16.0, 0.0), layer)).rgb);
  float hv = lum(texture(uTex, vec3(uv + vec2(0.0, 1.0 / 16.0), layer)).rgb);
  vec3 Nb = normalize(N - Tg * im * (hu - h0) * 2.2 - Bg * im * (hv - h0) * 2.2);

  vec3 V = uCam - vPos; float d = length(V); V /= d;
  float ao = vLS.y;
  // a gentle, slow breath of torchlight; a fast full-screen flicker is tiring to look at
  float flick = 1.0 + 0.012 * sin(uTime * 2.3) + 0.008 * sin(uTime * 3.7 + 1.3);
  float b = pow(clamp(vLS.x, 0.0, 1.0), 2.6) * 1.9 * flick;   // torch falloff curve: bright pools, dark gaps
  vec3 light = (vec3(0.04, 0.045, 0.07) + vec3(1.0, 0.72, 0.45) * b) * (0.7 + 0.3 * Nb.y) * ao;
  // the player's lantern, held low and to the right so stone relief catches it at an angle
  vec3 Ld = uLamp - vPos; float ld = length(Ld); Ld /= ld;
  float lamp = (1.0 - smoothstep(0.0, 10.0, ld)) / (1.0 + ld * ld * 0.06);
  float ndl = max(dot(Nb, Ld), 0.0), spec = pow(max(dot(Nb, normalize(Ld + V)), 0.0), 28.0);
  light += vec3(1.0, 0.66, 0.38) * lamp * (ndl * 0.75 + spec * 0.35 * h0) * mix(1.0, ao, 0.5);
  light += pointLights(vPos, Nb) * mix(1.0, ao, 0.5);
  vec3 col = lava ? t.rgb * 1.3 : t.rgb * light;
  if (abs(layer - uTorch) < 0.5 && h0 > 0.45) col = t.rgb * 2.2;   // the flame tip burns

  outColor = vec4(grade(col, d), 1.0);
}`;

// creatures, fireballs, particles, the portal and the gun: flat-coloured boxes lit like the world
const ENT_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec3 aCol; layout(location=3) in vec2 aLE;
uniform mat4 uMVP;
out vec3 vPos; out vec3 vNrm; out vec3 vCol; out vec2 vLE;
void main(){ vPos = aPos; vNrm = aNrm; vCol = aCol; vLE = aLE; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const ENT_FS = `#version 300 es
precision highp float;
uniform vec3 uCam; uniform vec3 uLamp;
${SHADER_COMMON}
in vec3 vPos; in vec3 vNrm; in vec3 vCol; in vec2 vLE;
out vec4 outColor;
void main(){
  vec3 N = normalize(vNrm);
  float d = length(uCam - vPos);
  float b = pow(clamp(vLE.x, 0.0, 1.0), 2.6) * 1.9;
  float shade = 0.74 + 0.26 * N.y + 0.06 * N.x;          // fixed face shading so boxes read as solid
  vec3 light = (vec3(0.05, 0.055, 0.08) + vec3(1.0, 0.72, 0.45) * b) * shade;
  vec3 Ld = uLamp - vPos; float ld = length(Ld); Ld /= max(ld, 1e-4);
  float lamp = (1.0 - smoothstep(0.0, 10.0, ld)) / (1.0 + ld * ld * 0.06);
  light += vec3(1.0, 0.66, 0.38) * lamp * (max(dot(N, Ld), 0.0) * 0.8 + 0.12);
  light += pointLights(vPos, N);
  vec3 col = mix(vCol * light, vCol * 1.5, vLE.y);
  outColor = vec4(grade(col, d), 1.0);
}`;

// soft additive halos: torch flames, fireballs, the portal, health shards
const GLOW_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aUVS; layout(location=2) in vec3 aCol;
uniform mat4 uMVP; uniform vec3 uCam;
out vec3 vUVS; out vec3 vCol; out float vD;
void main(){ vUVS = aUVS; vCol = aCol; vD = length(aPos - uCam); gl_Position = uMVP * vec4(aPos, 1.0); }`;
const GLOW_FS = `#version 300 es
precision mediump float;
uniform float uTime; in vec3 vUVS; in vec3 vCol; in float vD; out vec4 o;
void main(){
  vec2 p = vUVS.xy * 2.0 - 1.0; float r2 = dot(p, p);
  float f = 0.85 + 0.15 * sin(uTime * 9.0 + vUVS.z) * sin(uTime * 5.3 + vUVS.z * 2.7);
  vec3 c = vCol * exp(-r2 * 3.5) * 0.3 + mix(vCol, vec3(1.0), 0.45) * exp(-r2 * 30.0) * 0.6;
  o = vec4(c * f * exp(-pow(vD / 30.0, 2.0)), 1.0);
}`;

let blockProg, glowProg, entProg, glowMesh, entMesh, gunMesh, texArray;

function loadImage(name) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('missing img/' + name + '.png'));
    img.src = 'img/' + name + '.png';
  });
}

async function loadTextures() {
  const imgs = await Promise.all(TEX_NAMES.map(loadImage));
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(16 * 16 * 4 * imgs.length);
  imgs.forEach((img, i) => {
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(img, 0, 0, 16, 16);
    data.set(ctx.getImageData(0, 0, 16, 16).data, i * 1024); // throws SecurityError on file://
  });
  texArray = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 16, 16, imgs.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 3);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
}

// attrs: [location, size] in order; all floats, tightly packed
function makeMesh(attrs = [[0, 3], [1, 3], [2, 2]]) {
  const vao = gl.createVertexArray(), vbo = gl.createBuffer(), ibo = gl.createBuffer();
  const stride = attrs.reduce((s, a) => s + a[1], 0) * 4;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  let off = 0;
  for (const [loc, size] of attrs) {
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    off += size * 4;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bindVertexArray(null);
  return { vao, vbo, ibo, count: 0 };
}
function uploadMesh(m, out, usage = gl.STATIC_DRAW) {
  gl.bindVertexArray(m.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out.v), usage);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(out.i), usage);
  gl.bindVertexArray(null);
  m.count = out.i.length;
}

// meshing
// face: normal n, texture-right axis u, texture-up axis v (directional shading happens per pixel in the shader)
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];
// cube corners stay on the grid: walls are straight and blocks read as blocks (raise these for a hand-built wobble)
const WOBBLE_XZ = 0, WOBBLE_Y = 0;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const AOF = [0.45, 0.64, 0.82, 1.0];

// Bevelled cubes. Every outside edge (two open faces of a block meeting) is cut back: each open face shrinks away
// from that edge, a slanted strip fills it, a triangle fills a corner where three open faces meet, and a small cap
// closes a strip that runs into a neighbour without the same bevel. The cut is a thin, even chamfer, so edges catch
// the light without the blocks looking rounded off.
const faceOf = (axis, sign) => axis * 2 + (sign > 0 ? 0 : 1);
const bevelAt = () => 0.06;
function openFaces(x, y, z) {
  let open = 0;
  for (let f = 0; f < 6; f++) { const n = FACES[f].n; if (!opaqueAt(x + n[0], y + n[1], z + n[2])) open |= 1 << f; }
  return open;
}
// the point on face axis k (k = -1: the raw corner) at block corner s (a sign per axis): [world xyz, local xyz]
function bevelPt(x, y, z, k, s, open) {
  const cx = x + (s[0] + 1) / 2, cy = y + (s[1] + 1) / 2, cz = z + (s[2] + 1) / 2;
  const b = bevelAt(cx, cy, cz), p = [0, 0, 0, 0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const cut = k >= 0 && a !== k && (open >> faceOf(a, s[a])) & 1;
    p[a + 3] = 0.5 + s[a] * (0.5 - (cut ? b : 0));
  }
  p[0] = x + p[3] + (hash3(cx, cy, cz) - 0.5) * WOBBLE_XZ;
  p[1] = y + p[4] + (hash3(cx, cy + 97, cz) - 0.5) * WOBBLE_Y;
  p[2] = z + p[5] + (hash3(cx, cy, cz + 89) - 0.5) * WOBBLE_XZ;
  return p;
}
// texture coords come from projecting the local point onto face F, so cut-back faces aren't squashed
function pushPt(out, p, F, layer, L, ao) {
  const lx = p[3] - 0.5, ly = p[4] - 0.5, lz = p[5] - 0.5;
  out.v.push(p[0], p[1], p[2], lx * F.u[0] + ly * F.u[1] + lz * F.u[2] + 0.5,
    0.5 - (lx * F.v[0] + ly * F.v[1] + lz * F.v[2]), layer, L, ao);
}
const lightBeside = (x, y, z, f) => { const n = FACES[f].n; return getL(x + n[0], y + n[1], z + n[2]); };

function emitCube(out, x, y, z, layer) {
  const open = openFaces(x, y, z);
  if (!open) return;
  const isOpen = f => (open >> f) & 1;
  for (let f = 0; f < 6; f++) if (isOpen(f)) emitCubeFace(out, x, y, z, f, layer, open);

  for (let f = 0; f < 6; f++) for (let e = f + 1; e < 6; e++) {
    const k = f >> 1, j = e >> 1;
    if (k === j || !isOpen(f) || !isOpen(e)) continue;
    const m = 3 - k - j, nf = FACES[f].n, ne = FACES[e].n, F = FACES[f];
    const L = (lightBeside(x, y, z, f) + lightBeside(x, y, z, e)) / 30;
    const s = [0, 0, 0]; s[k] = nf[k]; s[j] = ne[j];
    const ends = [];
    for (const sm of [-1, 1]) {
      s[m] = sm;
      ends.push([bevelPt(x, y, z, k, s, open), bevelPt(x, y, z, j, s, open)]);
      if (isOpen(faceOf(m, sm))) continue; // the corner triangle closes this end
      const nb = [x, y, z]; nb[m] += sm;
      if (!opaqueAt(nb[0] + nf[0], nb[1] + nf[1], nb[2] + nf[2]) && !opaqueAt(nb[0] + ne[0], nb[1] + ne[1], nb[2] + ne[2])) continue;
      const base = out.v.length / 8;
      pushPt(out, ends[ends.length - 1][0], F, layer, L, 1);
      pushPt(out, ends[ends.length - 1][1], F, layer, L, 1);
      pushPt(out, bevelPt(x, y, z, -1, s, open), F, layer, L, 1);
      out.i.push(base, base + 1, base + 2);
    }
    const base = out.v.length / 8;
    pushPt(out, ends[0][0], F, layer, L, 1); pushPt(out, ends[1][0], F, layer, L, 1);
    pushPt(out, ends[1][1], F, layer, L, 1); pushPt(out, ends[0][1], F, layer, L, 1);
    out.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const fs = [faceOf(0, sx), faceOf(1, sy), faceOf(2, sz)];
    if (!fs.every(isOpen)) continue;
    const s = [sx, sy, sz], L = fs.reduce((a, f) => a + lightBeside(x, y, z, f), 0) / 45;
    const base = out.v.length / 8;
    for (let k = 0; k < 3; k++) pushPt(out, bevelPt(x, y, z, k, s, open), FACES[fs[0]], layer, L, 1);
    out.i.push(base, base + 1, base + 2);
  }
}

function emitCubeFace(out, x, y, z, f, layer, open) {
  const F = FACES[f], n = F.n, u = F.u, v = F.v;
  const fx = x + n[0], fy = y + n[1], fz = z + n[2];
  const base = out.v.length / 8;
  const bright = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const su = CORNERS[c][0], sv = CORNERS[c][1];
    const ax = fx + u[0] * su, ay = fy + u[1] * su, az = fz + u[2] * su;
    const bx = fx + v[0] * sv, by = fy + v[1] * sv, bz = fz + v[2] * sv;
    const cx = ax + v[0] * sv, cy = ay + v[1] * sv, cz = az + v[2] * sv;
    const o1 = opaqueAt(ax, ay, az), o2 = opaqueAt(bx, by, bz), oc = opaqueAt(cx, cy, cz);
    const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
    let sum = getL(fx, fy, fz), cnt = 1;
    if (!o1) { sum += getL(ax, ay, az); cnt++; }
    if (!o2) { sum += getL(bx, by, bz); cnt++; }
    if (!oc && !(o1 && o2)) { sum += getL(cx, cy, cz); cnt++; }
    const L = sum / cnt / 15;
    const s = [n[0] + u[0] * su + v[0] * sv, n[1] + u[1] * su + v[1] * sv, n[2] + u[2] * su + v[2] * sv];
    pushPt(out, bevelPt(x, y, z, f >> 1, s, open), F, layer, L, AOF[ao]);
    bright[c] = (L + 0.1) * AOF[ao];
  }
  if (bright[0] + bright[2] >= bright[1] + bright[3]) out.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  else out.i.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
}

// one face of an arbitrary box; uv = [s0,t0,s1,t1]; xf optionally transforms points
function emitBoxFace(out, f, box, uv, layer, L, shade, xf) {
  const F = FACES[f], n = F.n, base = out.v.length / 8;
  for (let c = 0; c < 4; c++) {
    const su = CORNERS[c][0], sv = CORNERS[c][1];
    const p = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const k = n[a] !== 0 ? n[a] : F.u[a] * su + F.v[a] * sv;
      p[a] = k > 0 ? box[a + 3] : box[a];
    }
    if (xf) xf(p);
    out.v.push(p[0], p[1], p[2], uv[0] + (uv[2] - uv[0]) * (su + 1) / 2, uv[1] + (uv[3] - uv[1]) * (1 - (sv + 1) / 2), layer, L, shade);
  }
  out.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const FULL = [0, 0, 1, 1];
const TORCH_OUT = 0.22, TORCH_LIFT = 0.26; // wall torches stand upright on a stone corbel
function torchXf(x, y, z, m) {
  if (!m) return p => { p[0] += x; p[1] += y; p[2] += z; };
  const [dx, dz] = DIRS[m];
  return p => { p[0] += dx * TORCH_OUT + x; p[1] += TORCH_LIFT + y; p[2] += dz * TORCH_OUT + z; };
}
function emitTorch(out, x, y, z, m, L = 1) {
  const box = [7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16], xf = torchXf(x, y, z, m);
  for (let f = 0; f < 6; f++) {
    const uv = f === 2 ? [7 / 16, 6 / 16, 9 / 16, 8 / 16] : f === 3 ? [7 / 16, 14 / 16, 9 / 16, 1] : [7 / 16, 6 / 16, 9 / 16, 1];
    emitBoxFace(out, f, box, uv, T.torch, L, 1, xf);
  }
  if (!m) return;
  // the corbel: runs from just behind the torch back into the (wobbly) wall
  const [dx, dz] = DIRS[m];
  const span = d => (d ? [Math.min(0.5 + d * 0.1, 0.5 + d * 0.8), Math.max(0.5 + d * 0.1, 0.5 + d * 0.8)] : [0.38, 0.62]);
  const [x0, x1] = span(dx), [z0, z1] = span(dz);
  const cb = [x + x0, y + TORCH_LIFT - 0.14, z + z0, x + x1, y + TORCH_LIFT, z + z1];
  for (let f = 0; f < 6; f++) emitBoxFace(out, f, cb, [4 / 16, 5 / 16, 12 / 16, 8 / 16], T.chiseled_stone, L * 0.8, 1);
}
function emitBars(out, x, y, z, L) {
  const conX = opaqueAt(x + 1, y, z) || opaqueAt(x - 1, y, z) || getB(x + 1, y, z) === BARS || getB(x - 1, y, z) === BARS;
  const conZ = opaqueAt(x, y, z + 1) || opaqueAt(x, y, z - 1) || getB(x, y, z + 1) === BARS || getB(x, y, z - 1) === BARS;
  if (conX || !conZ) emitBoxFace(out, 4, [x, y, z + 0.5, x + 1, y + 1, z + 0.5], FULL, T.iron_bars, L, 1);
  if (conZ || !conX) emitBoxFace(out, 0, [x + 0.5, y, z, x + 0.5, y + 1, z + 1], FULL, T.iron_bars, L, 1);
}
function emitLava(out, x, y, z) {
  const top = getB(x, y + 1, z) === LAVA ? 1 : 0.66; // sits below the bevelled rim of the pit
  const box = [x, y, z, x + 1, y + top, z + 1];
  for (let f = 0; f < 6; f++) {
    const n = FACES[f].n, nb = getB(x + n[0], y + n[1], z + n[2]);
    if (nb === LAVA || DEF[nb].opaque) continue;
    emitBoxFace(out, f, box, FULL, T.lava, 1, 1);
  }
}

const chunkMeshes = [];
function chunkAt(cx, cy, cz) { return chunkMeshes[(cy * CZ + cz) * CX + cx]; }
function buildChunk(cx, cy, cz) {
  const out = { v: [], i: [] };
  for (let y = cy * CS; y < cy * CS + CS; y++)
    for (let z = cz * CS; z < cz * CS + CS; z++)
      for (let x = cx * CS; x < cx * CS + CS; x++) {
        const i = idx(x, y, z), id = blocks[i];
        if (!id) continue;
        const d = DEF[id];
        switch (d.shape) {
          case 'cube': emitCube(out, x, y, z, d.tex); break;
          case 'torch': emitTorch(out, x, y, z, meta[i]); break;
          case 'bars': emitBars(out, x, y, z, light[i] / 15); break;
          case 'lava': emitLava(out, x, y, z); break;
        }
      }
  let m = chunkAt(cx, cy, cz);
  if (!m) { m = makeMesh(); chunkMeshes[(cy * CZ + cz) * CX + cx] = m; }
  uploadMesh(m, out);
}
function buildAllChunks() {
  for (let cy = 0; cy < CY; cy++) for (let cz = 0; cz < CZ; cz++) for (let cx = 0; cx < CX; cx++) buildChunk(cx, cy, cz);
}

const flames = []; // [x, y, z, flicker phase] at the tip of every torch
function collectFlames() {
  flames.length = 0;
  for (let i = 0; i < N; i++) {
    if (blocks[i] !== TORCH) continue;
    const x = i % WX, z = ((i / WX) | 0) % WZ, y = (i / (WX * WZ)) | 0;
    const p = [0.5, 0.62, 0.5];
    torchXf(x, y, z, meta[i])(p);
    flames.push([p[0], p[1], p[2], hash3(x, y, z) * 100]);
  }
}

// physics (shared by the player and creatures)
// anything with x, y (feet), z, half-width w and height h
const P = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: false, sneak: false, sprint: false,
  eye: 1.62, w: 0.3, h: 1.8, hp: MAX_HP };
const PH = 1.8, EPS = 1e-5;

function boxesFor(id, x, y, z) {
  const d = DEF[id];
  if (!d.solid) return null;
  return [[x, y, z, x + 1, y + 1, z + 1]];
}
function forEachBox(b, fn) {
  for (let y = Math.floor(b[1]); y <= Math.floor(b[4]); y++)
    for (let z = Math.floor(b[2]); z <= Math.floor(b[5]); z++)
      for (let x = Math.floor(b[0]); x <= Math.floor(b[3]); x++) {
        const bs = boxesFor(getB(x, y, z), x, y, z);
        if (bs) for (const bb of bs) fn(bb);
      }
}
const entBox = (e, x = e.x, y = e.y, z = e.z) => [x - e.w, y, z - e.w, x + e.w, y + e.h, z + e.w];
function overlaps(a, b) {
  return a[0] < b[3] - EPS && a[3] > b[0] + EPS && a[1] < b[4] - EPS && a[4] > b[1] + EPS && a[2] < b[5] - EPS && a[5] > b[2] + EPS;
}
function collide(e, axis, d) {
  if (d === 0) return 0;
  const want = d, b = entBox(e), s = b.slice();
  if (d < 0) s[axis] += d; else s[axis + 3] += d;
  const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
  forEachBox(s, bb => {
    if (!(bb[o1] < b[o1 + 3] - EPS && bb[o1 + 3] > b[o1] + EPS && bb[o2] < b[o2 + 3] - EPS && bb[o2 + 3] > b[o2] + EPS)) return;
    if (d > 0 && bb[axis] >= b[axis + 3] - EPS) d = Math.min(d, bb[axis] - b[axis + 3]);
    else if (d < 0 && bb[axis + 3] <= b[axis] + EPS) d = Math.max(d, bb[axis + 3] - b[axis]);
  });
  // only snap to 0 when something actually blocked the move; a tiny free move must stay a free move
  return d !== want && Math.abs(d) < EPS ? 0 : d;
}
function hasSupport(dx, dz) {
  const b = entBox(P, P.x + dx, P.y - 0.6, P.z + dz);
  let hit = false;
  forEachBox(b, bb => { if (!hit && overlaps(b, bb)) hit = true; });
  return hit;
}
function sneakClamp(dx, dz) { // sneaking never walks you off a ledge
  while (dx !== 0 && !hasSupport(dx, 0)) dx = Math.abs(dx) < 0.05 ? 0 : dx - 0.05 * Math.sign(dx);
  while (dz !== 0 && !hasSupport(0, dz)) dz = Math.abs(dz) < 0.05 ? 0 : dz - 0.05 * Math.sign(dz);
  while (dx !== 0 && dz !== 0 && !hasSupport(dx, dz)) {
    dx = Math.abs(dx) < 0.05 ? 0 : dx - 0.05 * Math.sign(dx);
    dz = Math.abs(dz) < 0.05 ? 0 : dz - 0.05 * Math.sign(dz);
  }
  return [dx, dz];
}
function touchingLava(e) {
  const b = entBox(e);
  for (let y = Math.floor(b[1]); y <= Math.floor(b[4]); y++)
    for (let z = Math.floor(b[2]); z <= Math.floor(b[5]); z++)
      for (let x = Math.floor(b[0]); x <= Math.floor(b[3]); x++)
        if (getB(x, y, z) === LAVA && overlaps(b, [x, y, z, x + 1, y + 0.875, z + 1])) return true;
  return false;
}
// push two bodies apart horizontally; share = how much of the correction body a takes
function pushApart(a, b, share) {
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.w + b.w + 0.05;
  if (d >= min) return;
  const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0, o = min - d;
  if (share > 0) { a.x += collide(a, 0, -nx * o * share); a.z += collide(a, 2, -nz * o * share); }
  if (share < 1) { b.x += collide(b, 0, nx * o * (1 - share)); b.z += collide(b, 2, nz * o * (1 - share)); }
}

// ray casts
// voxel ray walk (d must be unit length); returns the first block that stop(id) accepts, with the entry distance
// and the face normal it was entered through
function raycast(o, d, maxD, stop) {
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const st = d.map(Math.sign);
  const tD = d.map(v => (v === 0 ? Infinity : Math.abs(1 / v)));
  const tM = [0, 1, 2].map(a => (d[a] > 0 ? (Math.floor(o[a]) + 1 - o[a]) / d[a] : d[a] < 0 ? (o[a] - Math.floor(o[a])) / -d[a] : Infinity));
  let t = 0, axis = -1;
  while (t <= maxD) {
    if (!inside(x, y, z)) return null;
    const id = blocks[idx(x, y, z)];
    if (stop(id)) {
      const n = [0, 0, 0];
      if (axis >= 0) n[axis] = -st[axis];
      return { x, y, z, id, t, n };
    }
    const a = tM[0] < tM[1] ? (tM[0] < tM[2] ? 0 : 2) : (tM[1] < tM[2] ? 1 : 2);
    t = tM[a]; tM[a] += tD[a]; axis = a;
    if (a === 0) x += st[0]; else if (a === 1) y += st[1]; else z += st[2];
  }
  return null;
}
const shotStop = id => DEF[id].solid && id !== BARS; // bullets and eyes pass between the bars
function rayBox(o, d, b) {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < b[a] || o[a] > b[a + 3]) return Infinity; continue; }
    let ta = (b[a] - o[a]) / d[a], tb = (b[a + 3] - o[a]) / d[a];
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

// game state
// menu | play | dying | dead | done | cine | won   (play + no pointer lock = paused)
let state = 'menu';
function setState(s) { state = s; document.body.dataset.state = s; }
let level = 0, fresh = false, kills = 0, levelStart = { gold: 0, kills: 0 }, levelTime = 0, totalTime = 0;
let ammo = GUN.mag, fireCd = 0, reloadT = 0, recoil = 0, muzzleT = 0, muzzleRot = 0, mouseDown = false;
let gunBob = 0, gunSprint = 0, hitT = 0, sealedMsgT = 0;
let enemies = [], fireballs = [], particles = [], pickups = [], boss = null;
const safe = { x: 0, y: 0, z: 0 }; // the last spot on solid ground away from lava
const bossAlive = () => !!boss && !boss.dead;

const keys = {};
// a steady, fairly wide view: no head bob, no sprint zoom, no screen shake; all big motion-sickness triggers.
// Comfort settings, kept between visits: field of view, mouse speed, and camera effects (gun sway, the roll as you
// die, the sweeping ending shot, strong damage flashes), which are off unless you turn them on
const OPT = { fov: 90, sens: 8, motion: false };
try { Object.assign(OPT, JSON.parse(localStorage.getItem('dungeoncraft.opts') || '{}')); } catch (e) { /* private mode */ }
function saveOpts() { try { localStorage.setItem('dungeoncraft.opts', JSON.stringify(OPT)); } catch (e) { /* private mode */ } }
let lastWTap = 0, stepDist = 0;

function respawn() {
  P.x = spawn.x; P.y = spawn.y; P.z = spawn.z; P.vx = P.vy = P.vz = 0;
  P.yaw = 0; P.pitch = 0; P.eye = 1.62;
  safe.x = P.x; safe.y = P.y; safe.z = P.z;
}

// creatures
// hp, speed (blocks/s), half-width w, height h, head = height where the head hitbox starts,
// reach (melee range, 0 = none), dmg, cd = seconds between attacks, windup = telegraph before the blow lands
// special kinds: lift = flies this high off the floor; blast = explodes (radius) instead of striking, and when killed;
// lob = ranged shots arc and leave an acid pool; shield = blocks shots from the front except while swinging;
// rush = charges in a straight line at this speed (rushDmg on contact) and is dazed if it hits a wall;
// blink = vanishes and reappears nearby when hurt, or to close in; raise = keeps up to this many dead risen at once
const ETYPES = {
  gorehorn: { hp: 140, speed: 3.0, w: 0.44, h: 1.45, head: 1.05, reach: 1.7, rush: 11, rushDmg: 24, rushRange: [4, 13], dmg: 14, cd: 1.1, windup: 0.4, gold: 4, pitch: 0.7, drop: 0.45, stride: 2.4, blood: [0.5, 0.12, 0.08] },
  shade: { hp: 45, speed: 3.6, w: 0.3, h: 1.55, head: 1.15, lift: 0.4, reach: 1.6, blink: true, dmg: 12, cd: 1.1, windup: 0.35, gold: 2, pitch: 1.8, drop: 0.2, stride: 0, blood: [0.55, 0.85, 0.95] },
  gravecaller: { hp: 85, speed: 2.8, w: 0.3, h: 1.85, head: 1.45, reach: 0, keep: [7, 13], raise: 2, dmg: 0, cd: 4.5, windup: 0.9, gold: 4, pitch: 0.9, drop: 0.45, stride: 2.2, blood: [0.3, 0.5, 0.3] },
  ghoul: { hp: 60, speed: 3.7, w: 0.3, h: 1.7, head: 1.3, reach: 1.6, dmg: 10, cd: 0.9, windup: 0.32, gold: 1, pitch: 1.3, drop: 0.25, stride: 2.6, blood: [0.72, 0.68, 0.58] },
  bat: { hp: 28, speed: 5.0, w: 0.3, h: 0.5, head: 0.3, lift: 1.35, reach: 1.5, dmg: 6, cd: 0.8, windup: 0.22, gold: 1, pitch: 2.2, drop: 0.12, stride: 0, blood: [0.35, 0.18, 0.3] },
  bloater: { hp: 75, speed: 2.5, w: 0.42, h: 1.55, head: 1.2, reach: 1.8, blast: 3.2, dmg: 38, cd: 0, windup: 0.8, gold: 2, pitch: 0.75, drop: 0.3, stride: 2.0, blood: [1, 0.55, 0.15] },
  cultist: { hp: 90, speed: 3.0, w: 0.3, h: 1.85, head: 1.45, reach: 0, ranged: true, keep: [6, 12], dmg: 14, cd: 2.3, windup: 0.55, gold: 3, pitch: 1.0, drop: 0.4, stride: 2.2, blood: [0.45, 0.15, 0.5] },
  spitter: { hp: 55, speed: 3.4, w: 0.38, h: 0.85, head: 0.55, reach: 0, ranged: true, lob: true, keep: [5, 11], dmg: 10, cd: 2.1, windup: 0.5, gold: 2, pitch: 1.6, drop: 0.3, stride: 4.5, blood: [0.45, 0.8, 0.2] },
  warden: { hp: 150, speed: 2.9, w: 0.36, h: 1.95, head: 1.55, reach: 1.9, shield: true, dmg: 18, cd: 1.4, windup: 0.5, gold: 4, pitch: 0.85, drop: 0.5, stride: 2.2, blood: [0.55, 0.12, 0.1] },
  brute: { hp: 260, speed: 2.5, w: 0.48, h: 2.25, head: 1.78, reach: 2.1, dmg: 26, cd: 1.6, windup: 0.55, gold: 5, pitch: 0.6, drop: 0.7, stride: 1.9, blood: [0.5, 0.1, 0.08] },
  boss: { hp: 1300, speed: 2.3, w: 0.85, h: 3.3, head: 2.6, reach: 2.9, ranged: true, dmg: 30, cd: 1.9, windup: 0.6, gold: 40, pitch: 0.4, drop: 0, stride: 1.3, blood: [1, 0.5, 0.15] },
};
// how high a creature's body floats right now (fliers bob, and drop low to strike)
const liftOf = e => e.hov || 0;

function addEnemy(type, x, y, z) {
  const k = ETYPES[type];
  // creatures on deeper floors are a little tougher
  const hp = type === 'boss' ? k.hp : Math.round(k.hp * (1 + level * 0.03));
  const e = { type, k, x, y, z, vx: 0, vy: 0, vz: 0, w: k.w, h: k.h, hp, maxHp: hp, yaw: rand() * Math.PI * 2,
    alert: false, los: false, losT: rand() * 0.2, cd: 0.6 + rand(), atk: 0, cast: 0, strike: 0, hurt: 0,
    dead: false, deadT: 0, phase: rand() * 10, walkAmt: 0, strafe: rand() < 0.5 ? 1 : -1, strafeT: 0,
    enraged: false, summonT: 3, leash: null, summoned: false, hov: k.lift || 0,
    rush: 0, rushT: 0, rushWind: 0, rushCd: 1.5, rdir: [0, 1], rushHit: false, stun: 0, blinkCd: 1, owner: null };
  enemies.push(e);
  return e;
}

// the exact creatures for a floor: shares of the mix rounded by largest remainder, every listed kind at least once,
// shuffled so the kinds are spread through the rooms instead of left to chance
function rosterFor(cfg) {
  const n = Math.max(cfg.enemies, cfg.mix.length);
  const parts = cfg.mix.map(([t, p]) => ({ t, c: Math.max(1, Math.floor(p * n)), r: (p * n) % 1 }));
  let total = parts.reduce((s, o) => s + o.c, 0);
  const byRemainder = parts.slice().sort((a, b) => b.r - a.r);
  for (let k = 0; total < n; k = (k + 1) % byRemainder.length) { byRemainder[k].c++; total++; }
  while (total > n) { const big = parts.reduce((a, b) => (b.c > a.c ? b : a)); big.c--; total--; }
  const list = [];
  for (const o of parts) for (let k = 0; k < o.c; k++) list.push(o.t);
  for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
  return list;
}

function spawnEnemies(cfg) {
  const roomCells = rooms.filter(r => r !== spawnRoom).map(r => {
    const cells = [];
    for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) {
      const c = z * WX + x;
      if (!walk[c] || spawnDist[c] < 10) continue;
      if (r === exitRoom && Math.abs(x - exitPos[0]) <= 2 && Math.abs(z - exitPos[1]) <= 2) continue;
      cells.push([x, z]);
    }
    return { r, cells };
  }).filter(o => o.cells.length);
  if (cfg.boss) {
    const r = exitRoom;
    let best = null, bd = -1;
    for (const [x, z] of (roomCells.find(o => o.r === r) || { cells: [] }).cells) {
      const d = Math.hypot(x - exitPos[0], z - exitPos[1]);
      // a few blocks in front of the portal, with room around for his bulk
      if (d > 3 && d < 6 && walkAt(x + 1, z) && walkAt(x - 1, z) && walkAt(x, z + 1) && walkAt(x, z - 1) && d > bd) { bd = d; best = [x, z]; }
    }
    if (!best) best = [exitPos[0], exitPos[1] + 3];
    boss = addEnemy('boss', best[0] + 0.5, FY + 1, best[1] + 0.5);
    boss.leash = exitRoom;
  }
  const total = roomCells.reduce((s, o) => s + o.cells.length, 0);
  const placed = [];
  for (const type of total > 0 ? rosterFor(cfg) : []) {
    // big bodies need a little elbow room; rather than swap the creature for another kind, look for a roomier spot,
    // and only give up on spacing it out from the others as a last resort
    const roomy = ETYPES[type].w > 0.4;
    for (let tries = 0; tries < 60; tries++) {
      let w = rand() * total, o = roomCells[0];
      for (const rc of roomCells) { if ((w -= rc.cells.length) <= 0) { o = rc; break; } }
      const [x, z] = pick(o.cells);
      if (tries < 40 && placed.some(p => Math.hypot(p[0] - x, p[1] - z) < 2.5)) continue;
      if (roomy && !(walkAt(x + 1, z) && walkAt(x - 1, z) && walkAt(x, z + 1) && walkAt(x, z - 1))) continue;
      addEnemy(type, x + 0.5, FY + 1, z + 0.5);
      placed.push([x, z]);
      break;
    }
  }
}
// kinds that show up on this floor for the first time in the run
function newKinds(n) {
  const seen = new Set(LEVELS.slice(0, n).flatMap(c => c.mix.map(m => m[0])));
  return LEVELS[n].mix.map(m => m[0]).filter(t => !seen.has(t));
}

const volAt = e => 1 / (1 + Math.hypot(e.x - P.x, e.z - P.z) * 0.1);
function canSee(e) {
  const o = [e.x, e.y + liftOf(e) + e.h * 0.85, e.z], t = [P.x, P.y + P.eye, P.z];
  const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], l = Math.hypot(d[0], d[1], d[2]);
  if (l < 0.01) return true;
  const hit = raycast(o, [d[0] / l, d[1] / l, d[2] / l], l, shotStop);
  return !hit || hit.t >= l - 0.3;
}
function alertEnemy(e, loud = true) {
  if (e.alert || e.dead) return;
  e.alert = true;
  e.cd = Math.max(e.cd, 0.5);
  if (loud) sfx(e === boss ? 'roar' : 'alert', e.k.pitch, volAt(e));
  // the pack wakes up together
  for (const o of enemies) if (!o.alert && !o.dead && Math.hypot(o.x - e.x, o.z - e.z) < 8) { o.alert = true; o.cd = Math.max(o.cd, 0.8); }
}
// is the cell a little ahead in this direction somewhere a creature can stand?
const stepOk = (e, dir) => walkAt(e.x + dir[0] * (e.w + 0.45), e.z + dir[1] * (e.w + 0.45));
function directOk(e, nx, nz, len) {
  for (let t = 0.5; t <= len; t += 0.5)
    for (const s of [-1, 0, 1])
      if (!walkAt(e.x + nx * t - nz * e.w * s, e.z + nz * t + nx * e.w * s)) return false;
  return true;
}
function chaseDir(e, dx, dz, dist) {
  const nx = dx / dist, nz = dz / dist;
  if (e.los && directOk(e, nx, nz, Math.min(dist, 4))) return [nx, nz];
  const cx = Math.floor(e.x), cz = Math.floor(e.z);
  if (cx < 0 || cz < 0 || cx >= WX || cz >= WZ) return [nx, nz];
  const c = cz * WX + cx, here = flow[c];
  let best = -1, bd = here < 0 ? 1e9 : here;
  for (const n of [c - 1, c + 1, c - WX, c + WX]) if (n >= 0 && n < WX * WZ && flow[n] >= 0 && flow[n] < bd) { bd = flow[n]; best = n; }
  if (best < 0) return here === 0 || here < 0 ? [nx, nz] : null;
  const tx = (best % WX) + 0.5 - e.x, tz = ((best / WX) | 0) + 0.5 - e.z, l = Math.hypot(tx, tz) || 1;
  return [tx / l, tz / l];
}

const ACID_G = 14; // gravity on a spitter's glob
function castFire(e) {
  const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
  const hx = e.x + s * (e.w + 0.25), hy = e.y + e.h * 0.62, hz = e.z + c * (e.w + 0.25);
  if (e.k.lob) { // a glob lobbed at where you're standing: aim the arc so it lands at your feet
    const gx = P.x + P.vx * 0.25 - hx, gz = P.z + P.vz * 0.25 - hz, hd = Math.hypot(gx, gz) || 1;
    const spd = 8, T = hd / spd, gy = P.y + 0.3 - hy;
    fireballs.push({ x: hx, y: hy, z: hz, vx: gx / hd * spd, vy: (gy + 0.5 * ACID_G * T * T) / T, vz: gz / hd * spd,
      life: 4, dmg: e.k.dmg, acid: true });
    sfx('spit', e.k.pitch, volAt(e));
    return;
  }
  let tx = P.x - hx, ty = P.y + 1.2 - hy, tz = P.z - hz;
  const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
  const isBoss = e === boss, n = isBoss ? (e.enraged ? 7 : 5) : 1, spd = isBoss ? 9 : 10;
  for (let k = 0; k < n; k++) {
    const a = (k - (n - 1) / 2) * 0.17, ca = Math.cos(a), sa = Math.sin(a);
    fireballs.push({ x: hx, y: hy, z: hz, vx: (tx * ca + tz * sa) * spd, vy: ty * spd, vz: (-tx * sa + tz * ca) * spd,
      life: 5, dmg: isBoss ? 12 : e.k.dmg });
  }
  sfx('fireball', 1, volAt(e));
}

function summonAdd() {
  const r = exitRoom;
  for (let t = 0; t < 40; t++) {
    const x = r.x + 1 + Math.floor(Math.random() * (r.w - 2)), z = r.z + 1 + Math.floor(Math.random() * (r.d - 2));
    if (!walk[z * WX + x] || Math.hypot(x + 0.5 - P.x, z + 0.5 - P.z) < 5) continue;
    if (Math.abs(x - exitPos[0]) <= 1 && Math.abs(z - exitPos[1]) <= 1) continue;
    const g = addEnemy(['ghoul', 'ghoul', 'bat', 'bloater', 'shade'][Math.floor(Math.random() * 5)], x + 0.5, FY + 1, z + 0.5);
    g.summoned = true; g.alert = true; g.cd = 1;
    burst([g.x, g.y + 0.8, g.z], [1, 0.5, 0.15], 18, 3, 1);
    return;
  }
}

// a shade slips through the dark: it vanishes and reappears a few blocks away, around you (close) or around itself
function blink(e, close) {
  for (let t = 0; t < 30; t++) {
    const a = Math.random() * Math.PI * 2, r = close ? 2.5 + Math.random() * 1.5 : 3 + Math.random() * 2.5;
    const x = Math.floor((close ? P.x : e.x) + Math.sin(a) * r) + 0.5, z = Math.floor((close ? P.z : e.z) + Math.cos(a) * r) + 0.5;
    if (!walkAt(x, z) || Math.hypot(x - P.x, z - P.z) < 2.5) continue;
    // never through a wall: the floor must run unbroken from here to there
    const len = Math.hypot(x - e.x, z - e.z);
    let clear = true;
    for (let s = 0.5; s < len && clear; s += 0.5) clear = walkAt(e.x + (x - e.x) * s / len, e.z + (z - e.z) * s / len);
    if (!clear) continue;
    burst([e.x, e.y + liftOf(e) + 0.8, e.z], [0.55, 0.85, 0.95], 14, 2, 1);
    e.x = x; e.z = z; e.vx = e.vz = 0; e.atk = 0; e.blinkCd = 2.2;
    burst([e.x, e.y + liftOf(e) + 0.8, e.z], [0.55, 0.85, 0.95], 14, 2, 1);
    sfx('blink', e.k.pitch, volAt(e));
    return;
  }
}
// a gravecaller raises one of the dead beside it; they fall again when it does
const minionsOf = e => enemies.filter(o => o.owner === e && !o.dead).length;
function raiseDead(e) {
  for (let t = 0; t < 30; t++) {
    const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 1.5;
    const x = Math.floor(e.x + Math.sin(a) * r) + 0.5, z = Math.floor(e.z + Math.cos(a) * r) + 0.5;
    if (!walkAt(x, z) || Math.hypot(x - P.x, z - P.z) < 3) continue;
    const m = addEnemy(Math.random() < 0.7 ? 'ghoul' : 'bat', x, e.y, z);
    m.owner = e; m.alert = true; m.cd = 1;
    burst([x, e.y + 0.3, z], [0.45, 1, 0.55], 20, 2.5, 1);
    sfx('raise', 1, volAt(e));
    return;
  }
}

function updateEnemy(e, dt) {
  const K = e.k;
  if (e.dead) { e.deadT += dt; e.hov = Math.max(0, e.hov - dt * 5); return; } // fliers drop out of the air
  e.hurt = Math.max(0, e.hurt - dt);
  e.strike = Math.max(0, e.strike - dt);
  e.cd -= dt; e.rushCd -= dt; e.blinkCd -= dt;
  const dx = P.x - e.x, dz = P.z - e.z, dist = Math.max(Math.hypot(dx, dz), 1e-4), dy = P.y - e.y;
  if ((e.losT -= dt) <= 0) { e.losT = 0.12 + Math.random() * 0.1; e.los = dist < 36 && canSee(e); }
  if (!e.alert && ((e.los && dist < 20) || (dist < 3.5 && Math.abs(dy) < 3))) alertEnemy(e);
  if (K.blink && e.alert && e.los && dist > 9 && e.blinkCd <= 0 && e.atk <= 0) blink(e, true);

  const rage = e.enraged ? 1.35 : 1;
  let wx = 0, wz = 0;
  if (e.stun > 0) e.stun -= dt; // dazed after slamming into a wall: no moving, no attacking
  else if (e.alert) {
    e.yaw = turnTo(e.yaw, e.rush > 0 ? Math.atan2(e.rdir[0], e.rdir[1]) : Math.atan2(dx, dz), dt * 10);
    // ---- a gorehorn's charge: a straight line, no steering, until it hits you, a wall, or runs out of steam
    if (e.rush > 0) {
      e.rushT += dt;
      [wx, wz] = e.rdir;
      if (!e.rushHit && dist < K.reach + 0.2 && Math.abs(dy) < 2) {
        e.rushHit = true; hurtPlayer(K.rushDmg); sfx('thud', 1, 1);
        e.rush = Math.min(e.rush, 0.15);
      }
      if ((e.rush -= dt) <= 0) e.cd = K.cd;
    } else if (e.rushWind > 0) { // head down, pawing the floor: your cue to get out of its line
      if ((e.rushWind -= dt) <= 0) { e.rdir = [dx / dist, dz / dist]; e.rush = 1.4; e.rushT = 0; e.rushHit = false; sfx('rush', K.pitch, volAt(e)); }
    // ---- attacks: a visible windup, then the blow lands if you're still in reach
    } else if (e.atk > 0) {
      if ((e.atk -= dt) <= 0) {
        e.strike = 0.22; e.cd = K.cd / rage;
        if (K.blast) { explode(e); return; } // the fuse has burnt down
        if (dist < K.reach + 0.4 && Math.abs(dy) < 2) hurtPlayer(K.dmg);
      }
    } else if (e.cast > 0) {
      if ((e.cast -= dt) <= 0) { if (K.raise) raiseDead(e); else castFire(e); e.cd = K.cd / rage * (0.8 + Math.random() * 0.4); }
    } else if (e.cd <= 0) {
      if (K.reach && dist < K.reach && Math.abs(dy) < 2) {
        e.atk = e.atkMax = K.windup / rage;
        sfx(K.blast ? 'fuse' : 'swing', K.pitch, volAt(e));
      }
      else if (K.rush && e.los && e.rushCd <= 0 && dist > K.rushRange[0] && dist < K.rushRange[1] && Math.abs(dy) < 1.5 &&
               directOk(e, dx / dist, dz / dist, dist - 1)) {
        e.rushWind = e.rushWindMax = 0.75; e.rushCd = 4;
        sfx('snort', K.pitch, volAt(e));
      }
      else if (K.raise && e.los && dist < 20 && minionsOf(e) < K.raise) { e.cast = e.castMax = K.windup; sfx('cast', 0.6, volAt(e)); }
      else if (K.ranged && e.los && dist < 22) { e.cast = e.castMax = K.windup; sfx('cast', 1, volAt(e)); }
    }
    // ---- movement (everyone stands still while winding up, which is your opening)
    if (e.atk <= 0 && e.cast <= 0 && e.rush <= 0 && e.rushWind <= 0) {
      let dir = null;
      if (K.keep) { // casters keep their distance and sidestep
        if (!e.los || dist > K.keep[1]) dir = chaseDir(e, dx, dz, dist);
        else {
          if (dist < K.keep[0]) dir = [-dx / dist, -dz / dist];
          else {
            if ((e.strafeT -= dt) <= 0) { e.strafeT = 1 + Math.random() * 2; e.strafe = -e.strafe; }
            dir = [-dz / dist * e.strafe, dx / dist * e.strafe];
          }
          if (!stepOk(e, dir)) { e.strafe = -e.strafe; e.strafeT = 1.5; dir = null; }
        }
      } else if (dist > K.reach * 0.7) dir = chaseDir(e, dx, dz, dist);
      if (dir && K.lift) { // fliers weave from side to side as they come, which makes them hard to track
        const wv = Math.sin(time * 3.1 + e.phase) * 0.7, px = -dir[1], pz = dir[0];
        const nx = dir[0] + px * wv, nz = dir[1] + pz * wv, l = Math.hypot(nx, nz) || 1;
        if (stepOk(e, [nx / l, nz / l])) dir = [nx / l, nz / l];
      }
      if (dir && e.leash) { // the Ember Lord never leaves his hall
        const r = e.leash, nx = e.x + dir[0] * (e.w + 0.4), nz = e.z + dir[1] * (e.w + 0.4);
        if (nx < r.x + 0.2 || nx > r.x + r.w - 0.2 || nz < r.z + 0.2 || nz > r.z + r.d - 0.2) dir = null;
      }
      if (dir) { wx = dir[0]; wz = dir[1]; }
    }
    if (e === boss) {
      if (!e.enraged && e.hp < e.maxHp * 0.5) {
        e.enraged = true; e.summonT = 1.5;
        showMessage(TEXT.messages.bossRage); sfx('roar', K.pitch, 1);
      }
      if (e.enraged && (e.summonT -= dt) <= 0) {
        e.summonT = 11;
        const adds = enemies.filter(o => o.summoned && !o.dead).length;
        for (let k = adds; k < Math.min(3, adds + 2); k++) summonAdd();
      }
    }
  }

  const sp = (e.rush > 0 ? K.rush : K.speed) * rage, a = 1 - Math.exp(-10 * dt);
  e.vx += (wx * sp - e.vx) * a; e.vz += (wz * sp - e.vz) * a;
  e.vy = Math.max(e.vy - 30 * dt, -55);
  const wy = e.vy * dt, my = collide(e, 1, wy);
  if (my !== wy) e.vy = 0;
  e.y += my;
  const mx = collide(e, 0, e.vx * dt); if (mx !== e.vx * dt) e.vx = 0; e.x += mx;
  const mz = collide(e, 2, e.vz * dt); if (mz !== e.vz * dt) e.vz = 0; e.z += mz;
  const hs = Math.hypot(mx, mz) / dt;
  if (e.rush > 0 && e.rushT > 0.2 && hs < K.rush * 0.3) { // ran into something solid
    e.rush = 0; e.cd = K.cd;
    if (!e.rushHit) { e.stun = 1.6; sfx('thud', 1, volAt(e)); burst([e.x, e.y + 1, e.z], [0.5, 0.45, 0.4], 14, 2.5, 0); }
  }
  e.walkAmt += (Math.min(1, hs / K.speed) - e.walkAmt) * Math.min(1, dt * 8);
  e.phase += hs * dt * K.stride + dt * 0.6;
  if (K.lift) { // bob in the air, swooping down to your height for the bite
    const dive = e.atk > 0 ? 1 - e.atk / e.atkMax : e.strike > 0 ? 1 : 0;
    const want = lerp(K.lift + Math.sin(time * 2.4 + e.phase) * 0.12, Math.min(K.lift, 0.75), dive);
    e.hov += (want - e.hov) * Math.min(1, dt * 7);
  }
  if ((!K.lift && touchingLava(e)) || e.y < -5) killEnemy(e, false);
}

// a bloater going off: hurts everything in range, you and the creatures alike, and sets off other bloaters
let blasts = []; // brief flashes of light where something exploded
function explode(e) {
  if (e.exploded) return;
  e.exploded = true;
  const R = e.k.blast, c = [e.x, e.y + 0.8, e.z];
  burst(c, [1, 0.6, 0.2], 40, 6, 1, null, 0.7);
  burst(c, [0.3, 0.26, 0.22], 18, 3, 0, null, 0.9);
  blasts.push({ x: c[0], y: c[1], z: c[2], t: 0.4 });
  sfx('blast', 1, volAt(e));
  const dp = Math.hypot(P.x - e.x, P.y + 0.9 - c[1], P.z - e.z);
  if (dp < R) hurtPlayer(Math.round(e.k.dmg * (1 - (dp / R) * 0.7)));
  for (const o of enemies) {
    if (o === e || o.dead) continue;
    const d = Math.hypot(o.x - e.x, o.z - e.z);
    if (d < R) damageEnemy(o, e.k.dmg * 1.5 * (1 - (d / R) * 0.7), [(o.x - e.x) / (d || 1), 0, (o.z - e.z) / (d || 1)]);
  }
  killEnemy(e, false);
}

function damageEnemy(e, dmg, dir) {
  if (e.stun > 0) dmg *= 1.5; // a dazed gorehorn is wide open
  e.hp -= dmg; e.hurt = 0.1;
  alertEnemy(e);
  const kb = e === boss || e.rush > 0 ? 0 : e.type === 'brute' || e.type === 'gorehorn' ? 1.2 : e.type === 'warden' ? 1.6 : e.type === 'bat' ? 5 : 3.5;
  e.vx += dir[0] * kb; e.vz += dir[2] * kb;
  if (e.hp <= 0) killEnemy(e, true);
  else {
    sfx('ehurt', e.k.pitch, volAt(e));
    if (e.k.blink && e.blinkCd <= 0) blink(e, false); // shoot a shade and it's gone before the second shot
  }
}
function killEnemy(e, byPlayer) {
  if (e.dead) return;
  e.dead = true; e.deadT = 0; e.hp = 0; e.atk = e.cast = e.rush = e.rushWind = 0;
  if (byPlayer) { kills++; if (!e.owner) gold += e.k.gold; } // the risen carry nothing
  if (e.k.blast) explode(e); // shoot a bloater and it goes off where it stands
  if (e.k.raise) for (const o of enemies) if (o.owner === e) killEnemy(o, false); // its dead fall with it
  sfx('edie', e.k.pitch, volAt(e));
  burst([e.x, e.y + e.h * 0.5, e.z], e.k.blood, e === boss ? 60 : 16, e === boss ? 5 : 3, e === boss ? 1 : 0);
  if (byPlayer && Math.random() < e.k.drop) pickups.push({ x: e.x, y: e.y + 0.5, z: e.z, t: Math.random() * 6, hp: 20 });
  if (e === boss) {
    for (const o of enemies) if (o.summoned) killEnemy(o, false);
    showMessage(TEXT.messages.portalOpen, 5000);
    sfx('portal');
  }
  updateHud();
}

// the player
// soft: damage over time (standing in acid), which gets a faint tint instead of a full red flash every tick
function hurtPlayer(dmg, soft = false) {
  if (state !== 'play') return;
  P.hp = Math.max(0, P.hp - dmg);
  const f = soft ? 0.15 : Math.min(0.85, 0.3 + dmg / 40);
  flash(OPT.motion ? f : f * 0.6);
  sfx(soft ? 'sizzle' : 'hurt');
  updateHud();
  if (P.hp <= 0) startDeath();
}

function lavaNear() {
  const y = Math.floor(P.y - 0.5);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
    if (getB(Math.floor(P.x) + dx, y, Math.floor(P.z) + dz) === LAVA) return true;
  return false;
}

function updatePlayer(dt) {
  const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  P.sneak = !!keys.KeyC;
  if ((keys.ShiftLeft || keys.ShiftRight) && fwd > 0) P.sprint = true;
  if (fwd <= 0 || P.sneak) P.sprint = false;

  const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  let wx = -sy * fwd + cy * str, wz = -cy * fwd - sy * str;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx /= len; wz /= len; }
  const speed = P.sneak ? 1.3 : P.sprint ? 5.8 : 4.3;
  const k = P.onGround ? 16 : 2.2;
  const a = 1 - Math.exp(-k * dt);
  P.vx += (wx * speed - P.vx) * a;
  P.vz += (wz * speed - P.vz) * a;

  P.vy = Math.max(P.vy - 30 * dt, -55);
  if (keys.Space && P.onGround) {
    P.vy = 8.6;
    if (P.sprint) { P.vx += wx * 1.6; P.vz += wz * 1.6; }
  }

  const wantY = P.vy * dt, dy = collide(P, 1, wantY);
  P.onGround = wantY < 0 && dy > wantY;
  if (dy !== wantY) P.vy = 0;
  P.y += dy;

  let dx = P.vx * dt, dz = P.vz * dt;
  if (P.sneak && P.onGround) [dx, dz] = sneakClamp(dx, dz);
  const mx = collide(P, 0, dx);
  if (mx !== dx) P.vx = 0;
  P.x += mx;
  const mz = collide(P, 2, dz);
  if (mz !== dz) P.vz = 0;
  P.z += mz;

  // eye height (sneak lowers it), footsteps
  P.eye += ((P.sneak ? 1.32 : 1.62) - P.eye) * (1 - Math.exp(-dt * 14));
  const hs = Math.hypot(mx, mz) / Math.max(dt, 1e-4);
  if (P.onGround && hs > 0.3) {
    stepDist += hs * dt;
    gunBob += hs * dt * 1.9;
    if (stepDist > 1.75) {
      stepDist = 0;
      const below = getB(Math.floor(P.x), Math.floor(P.y - 0.2), Math.floor(P.z));
      sfx('step', DEF[below].sound);
    }
  }
  gunSprint += ((P.sprint && hs > 1 ? 1 : 0) - gunSprint) * Math.min(1, dt * 10);

  if (P.onGround && !lavaNear()) { safe.x = P.x; safe.y = P.y; safe.z = P.z; }
  if (touchingLava(P) || P.y < -10) {
    sfx('lava');
    showMessage(TEXT.messages.lavaBurn);
    P.x = safe.x; P.y = safe.y; P.z = safe.z; P.vx = P.vy = P.vz = 0;
    hurtPlayer(30);
    return;
  }

  // the exit portal
  if (exitPos && Math.abs(P.x - exitPos[0] - 0.5) < 0.45 && Math.abs(P.z - exitPos[1] - 0.5) < 0.5 && P.y < FY + 2.5) {
    if (bossAlive()) {
      if (time > sealedMsgT) { showMessage(TEXT.messages.portalSealed); sealedMsgT = time + 3; }
    } else completeLevel();
  }
}

// the revolver
function lookDir() {
  const cp = Math.cos(P.pitch);
  return [-Math.sin(P.yaw) * cp, Math.sin(P.pitch), -Math.cos(P.yaw) * cp];
}
function eyePos() { return [P.x, P.y + P.eye, P.z]; }

function startReload() {
  if (reloadT > 0 || ammo >= GUN.mag) return;
  reloadT = GUN.reload;
  sfx('reload');
}
function updateGun(dt) {
  fireCd = Math.max(0, fireCd - dt);
  recoil *= Math.exp(-dt * 14);
  muzzleT = Math.max(0, muzzleT - dt);
  if (hitT > 0 && (hitT -= dt) <= 0) crosshairEl.classList.remove('hit', 'head');
  if (reloadT > 0 && (reloadT -= dt) <= 0) { reloadT = 0; ammo = GUN.mag; }
  if (ammo === 0 && reloadT === 0 && fireCd === 0) startReload();
  if (mouseDown && reloadT === 0 && fireCd === 0 && ammo > 0) fire();
}
function fire() {
  ammo--; fireCd = GUN.rate; recoil = 1; muzzleT = 0.07; muzzleRot = Math.random() * Math.PI;
  sfx('shot');
  const o = eyePos(), d = lookDir();
  const moving = Math.hypot(P.vx, P.vz) > 1;
  const spread = !P.onGround ? 0.03 : P.sprint ? 0.025 : moving ? 0.008 : 0.002;
  for (let a = 0; a < 3; a++) d[a] += (Math.random() - 0.5) * 2 * spread;
  const l = Math.hypot(d[0], d[1], d[2]); d[0] /= l; d[1] /= l; d[2] /= l;

  const wall = raycast(o, d, GUN.range, shotStop);
  let bt = wall ? wall.t : GUN.range, hitE = null, head = false;
  for (const e of enemies) {
    if (e.dead) continue;
    const hw = e.w * (e.w > 0.4 ? 0.55 : 0.75), K = e.k, y0 = e.y + liftOf(e);
    const th = rayBox(o, d, [e.x - hw, y0 + K.head, e.z - hw, e.x + hw, y0 + e.h, e.z + hw]);
    const tb = rayBox(o, d, [e.x - e.w, y0, e.z - e.w, e.x + e.w, y0 + K.head, e.z + e.w]);
    if (th < bt) { bt = th; hitE = e; head = true; }
    if (tb < bt) { bt = tb; hitE = e; head = false; }
  }
  const hp = [o[0] + d[0] * bt, o[1] + d[1] * bt, o[2] + d[2] * bt];
  // a warden's shield stops body shots from the front; aim for the head, flank it, or catch it mid-swing
  if (hitE && hitE.k.shield && !head && !(hitE.atk > 0 || hitE.strike > 0) &&
      -(d[0] * Math.sin(hitE.yaw) + d[2] * Math.cos(hitE.yaw)) / (Math.hypot(d[0], d[2]) || 1) > 0.35) {
    burst(hp, [1, 0.85, 0.55], 8, 3.5, 1, [-d[0], -d[1], -d[2]], 0.25);
    sfx('clang');
    alertEnemy(hitE);
  } else if (hitE) {
    damageEnemy(hitE, GUN.dmg * (head ? 2 : 1), d);
    burst(hp, hitE.k.blood, head ? 10 : 6, 2.5, hitE === boss ? 1 : 0, [-d[0], -d[1], -d[2]]);
    crosshairEl.classList.add('hit'); crosshairEl.classList.toggle('head', head); hitT = 0.12;
    sfx('flesh', hitE.k.pitch);
  } else if (wall) {
    burst(hp, [1, 0.8, 0.45], 6, 3, 1, wall.n, 0.25);
    burst(hp, [0.4, 0.37, 0.34], 4, 1.5, 0, wall.n);
    if (Math.random() < 0.3) sfx('ricochet');
  }
  // gunfire carries
  for (const e of enemies) if (!e.dead && !e.alert && Math.hypot(e.x - P.x, e.z - P.z) < 16) alertEnemy(e, false);
}

// fireballs, particles, pickups
function burst(p, col, n, speed, em = 0, dir = null, life = 0.6) {
  for (let k = 0; k < n && particles.length < 600; k++) {
    let vx = (Math.random() - 0.5) * 2, vy = Math.random() * 1.6 - 0.3, vz = (Math.random() - 0.5) * 2;
    if (dir) { vx += dir[0] * 1.5; vy += dir[1] * 1.5; vz += dir[2] * 1.5; }
    const s = speed * (0.4 + Math.random() * 0.6);
    particles.push({ x: p[0], y: p[1], z: p[2], vx: vx * s, vy: vy * s, vz: vz * s, life: life * (0.5 + Math.random()),
      size: 0.03 + Math.random() * 0.04, col, em });
  }
}
const ACID = [0.55, 1, 0.25];
let pools = [], acidT = 0; // acid puddles a spitter's globs leave behind: {x, z, r, t}
function updateFireballs(dt) {
  for (let k = fireballs.length - 1; k >= 0; k--) {
    const f = fireballs[k];
    f.life -= dt;
    if (f.acid) f.vy -= ACID_G * dt;
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (Math.random() < dt * 40) particles.push({ x: f.x, y: f.y, z: f.z, vx: 0, vy: f.acid ? -0.4 : 0.6, vz: 0, life: 0.3, size: 0.05, col: f.acid ? ACID : [1, 0.45, 0.1], em: 1 });
    const id = getB(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z));
    const b = entBox(P), pad = 0.2;
    const hitP = f.x > b[0] - pad && f.x < b[3] + pad && f.y > b[1] - pad && f.y < b[4] + pad && f.z > b[2] - pad && f.z < b[5] + pad;
    if (hitP) hurtPlayer(f.dmg);
    if (hitP || (DEF[id].solid && id !== BARS) || f.life <= 0) {
      burst([f.x, f.y, f.z], f.acid ? ACID : [1, 0.55, 0.15], 14, 3, 1);
      sfx(f.acid ? 'splat' : 'boom', 1, volAt(f));
      // acid pools on the floor where it lands (or under you, if it hit you)
      if (f.acid && f.y < FY + 2.5 && walkAt(f.x, f.z)) pools.push({ x: f.x, z: f.z, r: 1.1, t: 5 });
      fireballs.splice(k, 1);
    }
  }
}
function updatePools(dt) {
  let inAcid = false;
  for (let k = pools.length - 1; k >= 0; k--) {
    const p = pools[k];
    if ((p.t -= dt) <= 0) { pools.splice(k, 1); continue; }
    if (P.onGround && P.y < FY + 1.3 && Math.hypot(P.x - p.x, P.z - p.z) < p.r) inAcid = true;
  }
  if (!inAcid) { acidT = 0; return; }
  if ((acidT -= dt) <= 0) { acidT = 0.5; hurtPlayer(5, true); }
}
function updateParticles(dt) {
  for (let k = particles.length - 1; k >= 0; k--) {
    const p = particles[k];
    if ((p.life -= dt) <= 0) { particles.splice(k, 1); continue; }
    p.vy -= 9 * dt;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
    if (DEF[getB(Math.floor(nx), Math.floor(ny), Math.floor(nz))].solid) { p.vy = -p.vy * 0.3; p.vx *= 0.5; p.vz *= 0.5; }
    else { p.x = nx; p.y = ny; p.z = nz; }
  }
  // the open portal breathes motes
  if (exitPos && !bossAlive() && Math.random() < dt * 14 && particles.length < 600)
    particles.push({ x: exitPos[0] + 0.1 + Math.random() * 0.8, y: FY + 1 + Math.random() * 2.5, z: exitPos[1] + 0.5 + (Math.random() - 0.5) * 0.3,
      vx: (Math.random() - 0.5) * 0.4, vy: 1.6, vz: (Math.random() - 0.5) * 0.4, life: 0.9, size: 0.035, col: [0.75, 0.55, 1], em: 1 });
}
function updatePickups(dt) {
  for (let k = pickups.length - 1; k >= 0; k--) {
    const p = pickups[k];
    p.t += dt;
    if (P.hp < MAX_HP && Math.hypot(P.x - p.x, P.z - p.z) < 0.9 && Math.abs(P.y + 0.9 - p.y) < 1.6) {
      P.hp = Math.min(MAX_HP, P.hp + p.hp);
      showMessage(fmt(TEXT.messages.health, { hp: p.hp }));
      sfx('heal'); updateHud();
      pickups.splice(k, 1);
    }
  }
}

const crosshairEl = document.getElementById('crosshair');
const ease = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = t => Math.max(0, Math.min(1, t));

// death: you crumple to the floor and it all goes dark
// the creatures keep moving while you fall, so you see them close in
let deathT = 0;
const DEATH = { fall: 1.0, fade: [1.2, 2.6], end: 3.0 };
function startDeath() {
  setState('dying');
  deathT = 0;
  mouseDown = false;
  for (const k in keys) keys[k] = false;
  P.vx *= 0.3; P.vz *= 0.3;
  death.eye = P.eye; death.pitch = P.pitch;
  death.side = Math.random() < 0.5 ? -1 : 1;
  sfx('death');
  flash(0.9);
  updateOverlay();
}
const death = { eye: 1.62, pitch: 0, side: 1 };
function updateDeath(dt) {
  deathT += dt;
  // the fall speeds up like a body toppling, then settles with a small bump
  const k = clamp01(deathT / DEATH.fall), fall = k * k;
  const settle = deathT > DEATH.fall ? Math.sin(Math.min(1, (deathT - DEATH.fall) / 0.25) * Math.PI) * 0.04 : 0;
  P.eye = lerp(death.eye, 0.28, fall) + settle;
  P.pitch = lerp(death.pitch, 0.12, ease(k));
  // keep the body in the world: gravity and collision still apply, but no steering
  P.vx *= Math.exp(-dt * 6); P.vz *= Math.exp(-dt * 6);
  P.vy = Math.max(P.vy - 30 * dt, -55);
  const my = collide(P, 1, P.vy * dt); if (my !== P.vy * dt) P.vy = 0; P.y += my;
  P.x += collide(P, 0, P.vx * dt); P.z += collide(P, 2, P.vz * dt);
  if (deathT >= DEATH.fall && deathT - dt < DEATH.fall) sfx('thud', 1, 1);
  fadeEl.style.background = '#000';
  fadeEl.style.opacity = 0.88 * ease((deathT - DEATH.fade[0]) / (DEATH.fade[1] - DEATH.fade[0]));
  if (deathT >= DEATH.end) { setState('dead'); endRun(); }
}
const deathRoll = () => death.side * (OPT.motion ? 1.25 : 0.1) * ease(clamp01(deathT / DEATH.fall) ** 1.5);

// the ending: the camera takes over in the Ember Lord's hall
// a slow orbit round the portal while gold rains down, a glide into the light, then title cards
let cineT = 0, portalBoost = 0;
const cine = { from: null, face: 0, side: 1, C: null };
const CINE = { blend: 1.6, orbit: 6.5, dolly: 9.0, white: [7.8, 9.0], black: [9.0, 9.8], cards: 9.8, cardGap: 1.4, end: 15.5 };
function startCutscene() {
  setState('cine');
  cineT = 0; portalBoost = 0;
  mouseDown = false;
  for (const k in keys) keys[k] = false;
  for (const e of enemies) if (!e.dead) killEnemy(e, false); // the dungeon's creatures crumble with their master
  const C = [exitPos[0] + 0.5, FY + 2.2, exitPos[1] + 0.5];
  cine.C = C;
  const cam = eyePos();
  cine.from = { pos: cam, yaw: P.yaw, pitch: P.pitch };
  // you're standing in the arch: the camera backs out the way you came (so it starts out already facing the portal),
  // swings out to a three-quarter view of the hall and back, then glides through
  cine.face = Math.cos(P.yaw) >= 0 ? 0 : Math.PI;
  cine.side = Math.random() < 0.5 ? -1 : 1;
  msgEl.style.opacity = 0;
  $('cards').textContent = '';
  for (const line of TEXT.cinematic) { const d = document.createElement('div'); d.textContent = line; $('cards').append(d); }
  $('skip').textContent = TEXT.skip;
  sfx('portal');
  sfx('cine');
  if (document.pointerLockElement) document.exitPointerLock();
  updateOverlay();
}
// camera for time t: orbit around the portal, blended in from the player's own view, then a glide into the portal
function cineCamera(t) {
  // without camera effects the shot just eases back and forward a little instead of swinging round the hall
  const C = cine.C, ko = ease(t / CINE.orbit), arc = Math.sin(ko * Math.PI), sweep = OPT.motion ? 1 : 0.25;
  const a = cine.face + cine.side * 0.28 * Math.PI * arc * sweep; // never so far round that the arch is seen edge-on
  const R = lerp(3.4, 6.4, (arc * 0.7 + ko * 0.3) * (OPT.motion ? 1 : 0.6));
  const h = FY + lerp(2.5, 4.6, arc * sweep);
  let pos = [C[0] + Math.sin(a) * R, h, C[2] + Math.cos(a) * R], look = C;
  if (t > CINE.orbit) { // glide straight through the arch, looking past it
    const kd = ease((t - CINE.orbit) / (CINE.dolly - CINE.orbit));
    const n = [Math.sin(a), 0, Math.cos(a)];
    const end = [C[0] + n[0] * 0.2, C[1], C[2] + n[2] * 0.2];
    pos = [0, 1, 2].map(i => lerp(pos[i], end[i], kd));
    look = [C[0] - n[0] * 4, C[1], C[2] - n[2] * 4];
  }
  const dx = look[0] - pos[0], dy = look[1] - pos[1], dz = look[2] - pos[2];
  let yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  const kb = ease(t / CINE.blend);
  if (kb < 1) {
    const f = cine.from;
    pos = [0, 1, 2].map(i => lerp(f.pos[i], pos[i], kb));
    yaw = turnTo(f.yaw, yaw, kb); pitch = lerp(f.pitch, pitch, kb);
  }
  return { pos, yaw, pitch, roll: 0 };
}
function updateCutscene(dt) {
  cineT += dt;
  const t = cineT;
  portalBoost = ease(t / 3);
  // gold rains from the vault of the hall
  const r = exitRoom;
  if (t > 1 && t < CINE.dolly) for (let n = 0; n < 2 && particles.length < 900; n++) if (Math.random() < dt * 30)
    particles.push({ x: r.x + 1 + Math.random() * (r.w - 2), y: FY + r.h - 1.5, z: r.z + 1 + Math.random() * (r.d - 2),
      vx: 0, vy: -1, vz: 0, life: 3, size: 0.045, col: [1, 0.8, 0.3], em: 0.7 });
  if (t > 1.5 && t - dt <= 1.5) burst([cine.C[0], FY + 2.5, cine.C[2]], [0.8, 0.6, 1], 60, 4, 1);
  if (Math.floor(t / 0.6) !== Math.floor((t - dt) / 0.6) && t < CINE.dolly) sfx('coins', 1, 0.5);
  // white out going through the portal, then down to black for the cards
  if (t < CINE.black[0]) {
    fadeEl.style.background = '#fff4dc';
    fadeEl.style.opacity = ease((t - CINE.white[0]) / (CINE.white[1] - CINE.white[0]));
  } else {
    const kb = ease((t - CINE.black[0]) / (CINE.black[1] - CINE.black[0]));
    const c = Math.round(lerp(255, 0, kb)), g = Math.round(lerp(244, 0, kb)), b = Math.round(lerp(220, 0, kb));
    fadeEl.style.background = `rgb(${c},${g},${b})`;
    fadeEl.style.opacity = 1;
  }
  const cards = $('cards').children;
  for (let i = 0; i < cards.length; i++) cards[i].style.opacity = ease((t - CINE.cards - i * CINE.cardGap) / 0.8);
  if (t >= CINE.end) finishCutscene();
}
function finishCutscene() {
  if (state !== 'cine') return;
  const cards = $('cards').children;
  for (let i = 0; i < cards.length; i++) cards[i].style.opacity = 0;
  fadeEl.style.background = '#000'; fadeEl.style.opacity = 0.75;
  setState('won');
  overlayGuard = performance.now() + 600;
  updateOverlay();
}
const fadeEl = document.getElementById('fade');

// levels & flow
function loadLevel(n) {
  level = n;
  const cfg = LEVELS[n];
  for (let a = 0; ; a++) {
    reseed(BASE_SEED + n * 1013 + a * 7919);
    if (generateDungeon(cfg) || a > 40) break;
  }
  computeLight();
  buildAllChunks();
  collectFlames();
  enemies = []; fireballs = []; particles = []; pools = []; blasts = []; acidT = 0; boss = null;
  pickups =healthSpots.map(([x, z]) => ({ x: x + 0.5, y: FY + 1.6, z: z + 0.5, t: rand() * 6, hp: 25 }));
  spawnEnemies(cfg);
  respawn();
  P.hp = MAX_HP;
  ammo = GUN.mag; reloadT = 0; fireCd = 0; recoil = 0; muzzleT = 0;
  levelTime = 0;
  levelStart = { gold, kills };
  flowCell = -1;
  fresh = true;
  updateHud();
}
function beginLevel() {
  setState('play'); fresh = false;
  fadeEl.style.opacity = 0;
  const name = TEXT.levelNames[level], newcomers = newKinds(level);
  let intro = fmt(LEVELS[level].boss ? TEXT.bossIntro : TEXT.levelIntro, { n: level + 1, name });
  if (newcomers.length) intro += '\n\n' + fmt(TEXT.newFoes, { names: newcomers.map(t => TEXT.enemyNames[t]).join(', ') });
  showMessage(intro, newcomers.length ? 5000 : 3500);
  updateHud();
  updateOverlay();
}
function completeLevel() {
  if (level === LEVELS.length - 1) { startCutscene(); return; }
  sfx('portal');
  setState('done');
  endRun();
}
// stop play and show the overlay for the current state
function endRun() {
  mouseDown = false;
  overlayGuard = performance.now() + 900;
  if (document.pointerLockElement) document.exitPointerLock();
  updateOverlay();
}

// HUD & overlay
const $ = id => document.getElementById(id);
const msgEl = $('message');
let msgTimer = 0;
function showMessage(t, ms = 2600) {
  msgEl.textContent = t; msgEl.style.opacity = 1;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (msgEl.style.opacity = 0), ms);
}
function flash(strength = 0.7) {
  const f = $('flash');
  f.style.transition = 'none'; f.style.opacity = strength;
  requestAnimationFrame(() => { f.style.transition = 'opacity .7s'; f.style.opacity = 0; });
}
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateHud() {
  if (!TEXT) return;
  $('hudlvl').textContent = fmt(TEXT.hud.level, { n: level + 1, total: LEVELS.length, name: TEXT.levelNames[level] });
  const st = $('hudstats');
  st.textContent = '';
  for (const s of [fmt(TEXT.hud.gold, { gold }), fmt(TEXT.hud.kills, { kills })]) {
    const sp = document.createElement('span'); sp.textContent = s; st.append(sp);
  }
  $('hpfill').style.width = (P.hp / MAX_HP * 100) + '%';
  $('hpnum').textContent = Math.ceil(P.hp);
  $('vitals').classList.toggle('low', P.hp <= 30);
}
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function updateHudLive() {
  setText('ammonum', fmt(TEXT.hud.ammo, { ammo, mag: GUN.mag }));
  setText('ammolbl', reloadT > 0 ? TEXT.hud.reloading : ammo === 0 ? TEXT.hud.reloadHint : '');
  const showBoss = bossAlive() && boss.alert;
  $('boss').style.display = showBoss ? 'block' : 'none';
  if (showBoss) $('bossfill').style.width = (boss.hp / boss.maxHp * 100) + '%';
}
function buildMenu() {
  document.title = TEXT.pageTitle;
  $('bossname').textContent = TEXT.bossName;
  $('hplbl').textContent = TEXT.hud.hp;
  const list = $('controls');
  list.textContent = '';
  for (const [key, act] of TEXT.controls) {
    const k = document.createElement('div'); k.className = 'key'; k.textContent = key;
    const a = document.createElement('div'); a.className = 'act'; a.textContent = act;
    list.append(k, a);
  }
  buildComfort();
}
function buildComfort() {
  const box = $('comfort'), C = TEXT.comfort;
  box.textContent = '';
  const row = (label, ctl, val) => {
    const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
    box.append(l, ctl);
    if (val) box.append(val); else box.append(document.createElement('div'));
  };
  const slider = (label, key, min, max, show) => {
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = 1; inp.value = OPT[key];
    const v = document.createElement('div'); v.className = 'val'; v.textContent = show(OPT[key]);
    inp.addEventListener('input', () => { OPT[key] = +inp.value; v.textContent = show(OPT[key]); saveOpts(); });
    row(label, inp, v);
  };
  slider(C.fov, 'fov', 70, 110, n => n + '°');
  slider(C.sens, 'sens', 1, 20, n => String(n));
  const tog = document.createElement('div'); tog.className = 'tog';
  const show = () => { tog.textContent = OPT.motion ? C.on : C.off; };
  tog.addEventListener('click', () => { OPT.motion = !OPT.motion; show(); saveOpts(); });
  show();
  row(C.motion, tog);
}
// clicks on the settings must not count as "click to play"
for (const ev of ['click', 'mousedown', 'pointerdown']) $('comfort').addEventListener(ev, e => e.stopPropagation());
let overlayGuard = 0;
function updateOverlay() {
  const overlay = $('overlay'), btn = $('playbtn');
  const hidden = (state === 'play' && locked) || state === 'dying' || state === 'cine';
  overlay.style.display = hidden ? 'none' : 'flex';
  if (!ready || hidden) return;
  const name = TEXT.levelNames[level], n = level + 1;
  const stats = { n, name, kills, gold, time: mmss(state === 'won' ? totalTime : levelTime) };
  const set = (title, status, button, controls) => {
    $('title').textContent = title; statusEl.textContent = status; btn.textContent = button;
    btn.style.display = ''; $('controls').style.display = $('comfort').style.display = controls ? '' : 'none';
  };
  if (state === 'menu') set(TEXT.title, fmt(TEXT.intro, { levels: LEVELS.length }), TEXT.play, true);
  else if (state === 'play') set(TEXT.pausedTitle, fmt(TEXT.levelLabel, stats), TEXT.resume, true);
  else if (state === 'done') set(TEXT.doneTitle, fmt(TEXT.doneStats, stats), TEXT.next, false);
  else if (state === 'dead') set(TEXT.deadTitle, fmt(TEXT.deadStats, stats), TEXT.retry, false);
  else if (state === 'won') set(TEXT.wonTitle, fmt(TEXT.wonStats, stats), TEXT.again, false);
}

// audio (procedural)
let AC = null, noiseBuf = null, VOL = 1;
function audio() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startAmbience();
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function noise(dur, freq, gain, type = 'bandpass', q = 1, delay = 0) {
  const ac = audio(), t = ac.currentTime + delay;
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain * VOL, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(ac.destination);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}
function tone(freq, dur, gain, type = 'triangle', delay = 0, slide = 0) {
  const ac = audio(), t = ac.currentTime + delay;
  const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(gain * VOL, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
}
// mat: a material name for footsteps, or a pitch multiplier for creature sounds; vol falls off with distance
function sfx(name, mat = 'stone', vol = 1) {
  if (!AC) return;
  VOL = Math.max(0.03, Math.min(1, vol));
  const fq = mat === 'wood' ? 0.55 : mat === 'metal' ? 2.2 : 1;
  const p = typeof mat === 'number' ? mat : 1;
  switch (name) {
    case 'step': noise(0.09, 700 * fq, 0.12); if (mat === 'wood') tone(160, 0.06, 0.05); break;
    case 'coins': [1320, 1760, 2090].forEach((f, k) => tone(f, 0.18, 0.06, 'triangle', k * 0.07)); break;
    case 'lava': noise(0.9, 260, 0.5, 'lowpass'); tone(70, 0.6, 0.15, 'sawtooth', 0, 0.5); break;
    case 'shot': noise(0.08, 2500, 0.35, 'bandpass', 0.6); noise(0.3, 500, 0.35, 'lowpass'); tone(110, 0.12, 0.18, 'square', 0, 0.35); break;
    case 'reload': noise(0.05, 3200, 0.15, 'highpass'); noise(0.05, 2400, 0.15, 'highpass', 1, 0.35);
      tone(900, 0.04, 0.05, 'square', 0.8); noise(0.06, 2000, 0.2, 'bandpass', 2, 0.9); break;
    case 'ricochet': tone(2600 + Math.random() * 800, 0.15, 0.025, 'sine', 0, 0.5); break;
    case 'flesh': noise(0.08, 600 * p, 0.16, 'bandpass', 1.5); break;
    case 'ehurt': tone(260 * p, 0.18, 0.07, 'sawtooth', 0, 0.6); break;
    case 'edie': tone(200 * p, 0.6, 0.1, 'sawtooth', 0, 0.3); noise(0.5, 300 * p, 0.2, 'lowpass'); break;
    case 'alert': tone(120 * p, 0.4, 0.07, 'sawtooth', 0, 1.5); tone(123 * p, 0.4, 0.05, 'square', 0.02, 1.4); break;
    case 'swing': noise(0.2, 900 * p, 0.18, 'bandpass', 2); break;
    case 'cast': tone(330, 0.5, 0.05, 'sine', 0, 2.5); tone(495, 0.5, 0.03, 'sine', 0, 2.5); break;
    case 'fireball': noise(0.45, 600, 0.18, 'lowpass'); break;
    case 'boom': noise(0.5, 260, 0.3, 'lowpass'); tone(70, 0.3, 0.1, 'sine', 0, 0.5); break;
    case 'hurt': tone(180, 0.18, 0.12, 'square', 0, 0.55); noise(0.12, 500, 0.2, 'lowpass'); break;
    case 'heal': [660, 880, 1100].forEach((f, k) => tone(f, 0.15, 0.05, 'sine', k * 0.06)); break;
    case 'portal': [392, 523, 659, 784].forEach((f, k) => tone(f, 0.5, 0.06, 'triangle', k * 0.09)); break;
    case 'thud': noise(0.25, 160, 0.45, 'lowpass'); tone(55, 0.3, 0.2, 'sine', 0, 0.6); break;
    case 'cine': { // a slow swell of chords under the ending, then a bright final fanfare
      const chords = [[131, 196, 262, 330], [110, 165, 220, 262], [87, 175, 220, 262], [98, 196, 247, 294]];
      chords.forEach((ch, i) => ch.forEach(f => tone(f, 2.4, 0.035, 'triangle', i * 2)));
      [523, 659, 784, 1047].forEach((f, k) => tone(f, 1.2, 0.05, 'triangle', 8 + k * 0.16));
      [262, 330, 392, 523].forEach(f => tone(f, 4, 0.04, 'triangle', 9.8));
      break;
    }
    case 'death': tone(220, 1.2, 0.12, 'sawtooth', 0, 0.25); noise(1, 200, 0.2, 'lowpass'); break;
    case 'roar': tone(70, 1.0, 0.18, 'sawtooth', 0, 0.6); noise(1.0, 250, 0.3, 'lowpass'); break;
    case 'spit': noise(0.12, 1400 * p, 0.14, 'bandpass', 3); tone(300 * p, 0.1, 0.04, 'sine', 0, 0.5); break;
    case 'splat': noise(0.25, 700, 0.18, 'lowpass'); noise(0.4, 3000, 0.05, 'highpass', 1, 0.05); break;
    case 'sizzle': noise(0.25, 3500, 0.06, 'highpass'); break;
    case 'fuse': noise(0.8, 4000, 0.08, 'highpass'); tone(500, 0.8, 0.03, 'sine', 0, 2.2); break;
    case 'blast': noise(1.0, 180, 0.6, 'lowpass'); tone(55, 0.7, 0.25, 'sine', 0, 0.4); noise(0.3, 1200, 0.2, 'bandpass'); break;
    case 'clang': tone(1250, 0.25, 0.06, 'square', 0, 0.9); tone(1870, 0.2, 0.04, 'triangle'); noise(0.08, 3000, 0.12, 'bandpass', 2); break;
    case 'snort': noise(0.35, 420 * p, 0.25, 'bandpass', 1.5); noise(0.3, 380 * p, 0.2, 'bandpass', 1.5, 0.4); break;
    case 'rush': tone(90 * p, 0.6, 0.1, 'sawtooth', 0, 1.6); noise(0.6, 300, 0.25, 'lowpass'); break;
    case 'blink': tone(1500, 0.25, 0.04, 'sine', 0, 0.3); noise(0.2, 5000, 0.06, 'highpass'); break;
    case 'raise': tone(110, 1.0, 0.06, 'triangle', 0, 2); tone(165, 1.0, 0.04, 'sine', 0.1, 2); noise(0.8, 300, 0.12, 'lowpass'); break;
  }
}
function startAmbience() {
  const ac = AC, g = ac.createGain(); g.gain.value = 0.035; g.connect(ac.destination);
  for (const f of [55, 55.7, 82.4]) { const o = ac.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); }
  const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240;
  const ng = ac.createGain(); ng.gain.value = 0.05;
  src.connect(lp).connect(ng).connect(ac.destination); src.start();
}

// input
let locked = false, ready = false;
// ask for raw mouse input (no OS acceleration, so the view turns exactly as far as your hand does), and fall back
// to a plain lock where that isn't supported
function lock() {
  const plain = () => { const q = canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); };
  let p;
  try { p = canvas.requestPointerLock({ unadjustedMovement: true }); } catch (e) { plain(); return; }
  if (p && p.catch) p.catch(plain); // older browsers return nothing and simply ignore the option
}
$('overlay').addEventListener('click', () => {
  if (!ready || performance.now() < overlayGuard) return;
  audio();
  if (state === 'dying' || state === 'cine') return;
  lock();
  if (state === 'menu') { if (!fresh) loadLevel(START_LEVEL); beginLevel(); }
  else if (state === 'done') { loadLevel(level + 1); beginLevel(); }
  else if (state === 'dead') { gold = levelStart.gold; kills = levelStart.kills; loadLevel(level); beginLevel(); }
  else if (state === 'won') { gold = 0; kills = 0; totalTime = 0; loadLevel(0); beginLevel(); }
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked) { for (const k in keys) keys[k] = false; mouseDown = false; }
  updateOverlay();
});
document.addEventListener('mousemove', e => {
  if (!locked || state !== 'play') return;
  // some browsers report a huge bogus jump right after locking or on a hitch; a sudden snap of the whole view is
  // one of the worst things for motion sickness, so ignore those
  if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
  const s = OPT.sens * 0.0003;
  P.yaw -= e.movementX * s;
  P.pitch = Math.max(-1.5605, Math.min(1.5605, P.pitch - e.movementY * s));
});
canvas.addEventListener('mousedown', e => { if (locked && state === 'play' && e.button === 0) mouseDown = true; });
// any click or key skips the ending (after a moment, so a stray shot doesn't)
document.addEventListener('mousedown', () => { if (state === 'cine' && cineT > 1) finishCutscene(); });
document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (state === 'cine' && cineT > 1 && e.code !== 'Escape') { finishCutscene(); return; }
  if (!locked || state !== 'play') return;
  if (e.code === 'KeyW' && !keys.KeyW) {
    const now = performance.now();
    if (now - lastWTap < 300) P.sprint = true;
    lastWTap = now;
  }
  if (!e.repeat && e.code === 'KeyR') startReload();
  keys[e.code] = true;
  if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = false; });

// entity meshes (rebuilt every frame)
const EM = { v: [], i: [] };
const E = { L: 1, flash: false }; // light level and hit-flash for the boxes being emitted
function ebox(xf, x0, y0, z0, x1, y1, z1, col, em = 0) {
  let c = col, e = em;
  if (E.flash) { c = [c[0] * 0.4 + 0.6, c[1] * 0.4 + 0.6, c[2] * 0.4 + 0.6]; e = Math.max(e, 0.5); }
  const b = [x0, y0, z0, x1, y1, z1];
  for (let f = 0; f < 6; f++) {
    const F = FACES[f], n = F.n, base = EM.v.length / 11, nw = xfDir(xf, n);
    for (let k = 0; k < 4; k++) {
      const su = CORNERS[k][0], sv = CORNERS[k][1], p = [0, 0, 0];
      for (let a = 0; a < 3; a++) { const s = n[a] !== 0 ? n[a] : F.u[a] * su + F.v[a] * sv; p[a] = s > 0 ? b[a + 3] : b[a]; }
      const w = xfApply(xf, p);
      EM.v.push(w[0], w[1], w[2], nw[0], nw[1], nw[2], c[0], c[1], c[2], E.L, e);
    }
    EM.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
// a box given by centre and half-size
const cbox = (xf, c, h, col, em) => ebox(xf, c[0] - h[0], c[1] - h[1], c[2] - h[2], c[0] + h[0], c[1] + h[1], c[2] + h[2], col, em);
const joint = (xf, x, y, z, ax = 0) => XF.mul(XF.mul(xf, XF.t(x, y, z)), XF.rx(ax));

const PAL = {
  bone: [0.66, 0.63, 0.54], boneD: [0.42, 0.4, 0.34], rag: [0.24, 0.19, 0.16], eyeR: [1, 0.25, 0.12],
  robe: [0.3, 0.13, 0.34], robeD: [0.17, 0.07, 0.2], trim: [0.72, 0.52, 0.2], ember: [1, 0.55, 0.15], void: [0.03, 0.02, 0.03],
  skin: [0.48, 0.3, 0.22], iron: [0.26, 0.26, 0.28], pants: [0.3, 0.22, 0.17], tusk: [0.85, 0.82, 0.7], eyeY: [1, 0.85, 0.3],
  char: [0.15, 0.12, 0.12], charD: [0.09, 0.07, 0.07], horn: [0.72, 0.66, 0.56], lava: [1, 0.45, 0.1],
  hide: [0.22, 0.15, 0.17], hideD: [0.12, 0.08, 0.1], wing: [0.3, 0.18, 0.21],
  bloat: [0.62, 0.54, 0.4], bloatD: [0.42, 0.34, 0.26],
  chitin: [0.21, 0.25, 0.14], chitinD: [0.12, 0.15, 0.09], acid: [0.5, 0.95, 0.2],
  plate: [0.44, 0.45, 0.48], plateD: [0.26, 0.26, 0.29], tabard: [0.45, 0.1, 0.08], shield: [0.34, 0.22, 0.12],
  brass: [0.78, 0.58, 0.22], visor: [0.6, 0.85, 1],
  fur: [0.36, 0.24, 0.17], furD: [0.2, 0.13, 0.1], hoof: [0.12, 0.1, 0.09],
  shroud: [0.52, 0.58, 0.62], shroudD: [0.3, 0.35, 0.4], wisp: [0.55, 0.9, 1],
  grave: [0.22, 0.25, 0.2], graveD: [0.12, 0.14, 0.11], soul: [0.45, 1, 0.55],
};
// arm angle: rest, raised during the windup, slammed forward just after the blow
function armPose(e, rest, raised, slam) {
  if (e.atk > 0) return lerp(rest, raised, 1 - e.atk / e.atkMax);
  if (e.strike > 0) return lerp(slam, raised, e.strike / 0.22 * 0.3);
  return rest;
}

function drawGhoul(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt, leg = 0.65 * sw;
  ebox(joint(base, -0.12, 0.75, 0, leg), -0.07, -0.75, -0.07, 0.07, 0, 0.07, PAL.rag);
  ebox(joint(base, 0.12, 0.75, 0, -leg), -0.07, -0.75, -0.07, 0.07, 0, 0.07, PAL.rag);
  const torso = joint(base, 0, 0.75, 0, 0.35 + Math.sin(e.phase * 0.7) * 0.04);
  ebox(torso, -0.21, 0, -0.12, 0.21, 0.6, 0.12, PAL.bone);
  ebox(torso, -0.15, 0.18, 0.12, 0.15, 0.46, 0.15, PAL.boneD);
  ebox(torso, -0.23, -0.06, -0.14, 0.23, 0.14, 0.14, PAL.rag);
  const head = joint(torso, 0, 0.6, 0.04, -0.3);
  ebox(head, -0.16, 0, -0.16, 0.16, 0.3, 0.16, PAL.bone);
  ebox(head, -0.12, -0.05, 0.02, 0.12, 0.06, 0.18, PAL.boneD);
  ebox(head, -0.11, 0.14, 0.16, -0.04, 0.2, 0.18, PAL.eyeR, 1);
  ebox(head, 0.04, 0.14, 0.16, 0.11, 0.2, 0.18, PAL.eyeR, 1);
  for (const s of [-1, 1]) {
    const a = armPose(e, -0.45 + s * sw * 0.5, -2.6, -0.9);
    const arm = joint(torso, s * 0.27, 0.55, 0, a);
    ebox(arm, -0.055, -0.62, -0.055, 0.055, 0, 0.055, PAL.bone);
    ebox(arm, -0.07, -0.74, -0.04, 0.07, -0.6, 0.08, PAL.boneD);
  }
}
function drawCultist(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt;
  const body = XF.mul(base, XF.rz(sw * 0.06));
  ebox(body, -0.34, 0, -0.3, 0.34, 0.5, 0.3, PAL.robeD);
  ebox(body, -0.36, 0.02, -0.32, 0.36, 0.1, 0.32, PAL.trim);
  ebox(body, -0.28, 0.5, -0.22, 0.28, 1.1, 0.22, PAL.robe);
  ebox(body, -0.25, 1.1, -0.2, 0.25, 1.45, 0.2, PAL.robe);
  ebox(body, -0.05, 0.5, 0.21, 0.05, 1.42, 0.24, PAL.trim);
  ebox(body, -0.2, 1.42, -0.2, 0.2, 1.82, 0.2, PAL.robeD);
  ebox(body, -0.12, 1.8, -0.18, 0.12, 1.9, 0.06, PAL.robeD);
  ebox(body, -0.13, 1.47, 0.2, 0.13, 1.72, 0.21, PAL.void);
  ebox(body, -0.09, 1.59, 0.21, -0.03, 1.64, 0.22, PAL.ember, 1);
  ebox(body, 0.03, 1.59, 0.21, 0.09, 1.64, 0.22, PAL.ember, 1);
  const ck = e.cast > 0 ? 1 - e.cast / e.castMax : 0;
  for (const s of [-1, 1]) {
    const arm = joint(body, s * 0.32, 1.38, 0, lerp(-0.25 - s * sw * 0.3, -1.45, Math.min(1, ck * 2.5)));
    ebox(arm, -0.08, -0.55, -0.08, 0.08, 0, 0.08, PAL.robe);
    ebox(arm, -0.055, -0.66, -0.055, 0.055, -0.55, 0.055, PAL.ember, 0.25 + ck * 0.75);
  }
}
function drawBrute(e, base, isBoss) {
  const sw = Math.sin(e.phase) * e.walkAmt, leg = 0.5 * sw;
  if (isBoss) base = XF.mul(base, XF.s(1.45));
  const C = isBoss ? { skin: PAL.char, pants: PAL.charD, metal: [0.2, 0.15, 0.13], eye: PAL.lava }
    : { skin: PAL.skin, pants: PAL.pants, metal: PAL.iron, eye: PAL.eyeY };
  for (const s of [-1, 1]) {
    const l = joint(base, s * 0.22, 0.9, 0, s * leg);
    ebox(l, -0.15, -0.9, -0.15, 0.15, 0, 0.15, C.pants);
    ebox(l, -0.17, -0.9, -0.17, 0.17, -0.74, 0.21, C.metal);
  }
  const torso = joint(base, 0, 0.9, 0, 0.15);
  ebox(torso, -0.45, 0, -0.3, 0.45, 0.85, 0.3, C.skin);
  ebox(torso, -0.47, 0, -0.32, 0.47, 0.16, 0.32, C.metal);
  if (isBoss) { // lava seams glowing through charred hide
    const em = 0.75 + 0.25 * Math.sin(time * 3);
    for (const zf of [0.3, -0.32]) {
      ebox(torso, -0.3, 0.22, zf, -0.24, 0.72, zf + 0.02, PAL.lava, em);
      ebox(torso, 0.08, 0.3, zf, 0.14, 0.8, zf + 0.02, PAL.lava, em);
      ebox(torso, -0.24, 0.5, zf, 0.3, 0.55, zf + 0.02, PAL.lava, em);
    }
  }
  const head = joint(torso, 0, 0.85, 0.06);
  ebox(head, -0.2, 0, -0.2, 0.2, 0.38, 0.22, C.skin);
  ebox(head, -0.13, 0.2, 0.22, -0.05, 0.25, 0.23, C.eye, 1);
  ebox(head, 0.05, 0.2, 0.22, 0.13, 0.25, 0.23, C.eye, 1);
  ebox(head, -0.15, -0.02, 0.2, -0.1, 0.1, 0.25, PAL.tusk);
  ebox(head, 0.1, -0.02, 0.2, 0.15, 0.1, 0.25, PAL.tusk);
  if (isBoss) {
    for (const s of [-1, 1]) {
      ebox(head, s > 0 ? 0.18 : -0.38, 0.26, -0.05, s > 0 ? 0.38 : -0.18, 0.36, 0.05, PAL.horn);
      ebox(head, s > 0 ? 0.3 : -0.38, 0.36, -0.05, s > 0 ? 0.38 : -0.3, 0.62, 0.05, PAL.horn);
    }
    for (let k = 0; k < 5; k++) { // a crown of flame
      const x = -0.16 + k * 0.08, hgt = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(time * 9 + k * 1.7));
      ebox(head, x - 0.03, 0.38, -0.03, x + 0.03, 0.38 + hgt, 0.03, PAL.lava, 1);
    }
  } else ebox(head, -0.22, 0.28, -0.22, 0.22, 0.44, 0.24, C.metal);
  const ck = e.cast > 0 ? 1 - e.cast / e.castMax : 0;
  for (const s of [-1, 1]) {
    let a = armPose(e, -0.15 - s * sw * 0.4, -2.8, -0.6);
    if (ck > 0 && s > 0) a = lerp(-0.15, -1.5, Math.min(1, ck * 2));
    const arm = joint(torso, s * 0.56, 0.75, 0, a);
    ebox(arm, -0.14, -0.62, -0.14, 0.14, 0, 0.14, C.skin);
    ebox(arm, -0.18, -0.95, -0.18, 0.18, -0.6, 0.18, C.metal, isBoss ? (s > 0 ? 0.3 + ck * 0.7 : 0.3) : 0);
  }
}
// gloomwing: a bat the size of a dog; wings beat, and it tips nose-down as it dives to bite
function drawBat(e, base) {
  const flap = Math.sin(time * 16 + e.phase * 3) * 0.8;
  const dive = e.atk > 0 ? 1 - e.atk / e.atkMax : e.strike > 0 ? 1 : 0;
  const body = XF.mul(base, XF.rx(0.2 + dive * 0.6));
  ebox(body, -0.12, 0.06, -0.2, 0.12, 0.3, 0.14, PAL.hide);
  ebox(body, -0.1, 0.16, 0.12, 0.1, 0.36, 0.3, PAL.hide);
  for (const s of [-1, 1]) {
    ebox(body, s * 0.04, 0.34, 0.16, s * 0.1, 0.48, 0.2, PAL.hideD);                     // ears
    ebox(body, s * 0.03, 0.27, 0.3, s * 0.075, 0.31, 0.31, PAL.eyeR, 1);                 // eyes
    ebox(body, s * 0.02, 0.13, 0.27, s * 0.04, 0.18, 0.3, PAL.bone);                     // fangs
    const wing = XF.chain(body, XF.t(s * 0.11, 0.24, -0.02), XF.rz(s * flap));
    ebox(wing, Math.min(0, s * 0.5), -0.012, -0.12, Math.max(0, s * 0.5), 0.012, 0.14, PAL.wing);
    const tip = XF.chain(wing, XF.t(s * 0.5, 0, 0), XF.rz(s * flap * 0.6));
    ebox(tip, Math.min(0, s * 0.34), -0.01, -0.07, Math.max(0, s * 0.34), 0.01, 0.1, PAL.hideD);
    ebox(body, s * 0.05 - 0.02, -0.06, -0.08, s * 0.05 + 0.02, 0.06, -0.04, PAL.hideD); // dangling feet
  }
}
// bloater: a swollen husk full of embers; when it reaches you it stops, swells and glows hotter, then bursts
function drawBloater(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt, fuse = e.atk > 0 ? 1 - e.atk / e.atkMax : 0;
  for (const s of [-1, 1]) ebox(joint(base, s * 0.2, 0.42, 0, s * sw * 0.5), -0.1, -0.42, -0.1, 0.1, 0, 0.1, PAL.bloatD);
  const swell = 1 + fuse * 0.28 + Math.sin(time * 2 + e.phase) * 0.02;
  const body = XF.chain(base, XF.t(0, 0.82, 0), XF.s(swell), XF.t(0, -0.82, 0));
  ebox(body, -0.4, 0.4, -0.36, 0.4, 1.24, 0.36, PAL.bloat);   // three overlapping boxes read as round
  ebox(body, -0.46, 0.55, -0.28, 0.46, 1.1, 0.28, PAL.bloat);
  ebox(body, -0.28, 0.55, -0.44, 0.28, 1.1, 0.44, PAL.bloat);
  const glow = 0.35 + 0.65 * fuse;
  for (const [x, y, z] of [[0.18, 0.95, 0.44], [-0.2, 0.7, 0.44], [0.46, 0.8, 0.05], [-0.46, 0.9, -0.1], [0.05, 0.62, -0.44], [-0.15, 1.24, 0.1]])
    cbox(body, [x, y, z], [0.07, 0.07, 0.07], PAL.ember, glow);
  const head = joint(body, 0, 1.22, 0.1, -0.1);
  ebox(head, -0.15, 0, -0.14, 0.15, 0.24, 0.16, PAL.bloatD);
  ebox(head, -0.1, 0.1, 0.16, -0.04, 0.15, 0.17, PAL.ember, 1);
  ebox(head, 0.04, 0.1, 0.16, 0.1, 0.15, 0.17, PAL.ember, 1);
  for (const s of [-1, 1]) {
    const arm = joint(body, s * 0.47, 0.95, 0, lerp(-0.3 + s * sw * 0.3, -1.4, fuse));
    ebox(arm, -0.06, -0.4, -0.06, 0.06, 0, 0.06, PAL.bloatD);
  }
}
// spitter: a low, many-legged crawler with acid sacs on its back; its jaw gapes as it hawks up a glob
function drawSpitter(e, base) {
  const ck = e.cast > 0 ? 1 - e.cast / e.castMax : 0;
  const body = XF.mul(base, XF.rx(-ck * 0.25)); // rears up to spit
  ebox(body, -0.22, 0.32, -0.42, 0.22, 0.6, 0.3, PAL.chitin);
  ebox(body, -0.18, 0.28, -0.55, 0.18, 0.5, -0.4, PAL.chitinD);
  for (const [x, z] of [[-0.1, -0.25], [0.1, -0.05], [-0.08, 0.12]])
    cbox(body, [x, 0.66, z], [0.08, 0.07, 0.08], PAL.acid, 0.45 + ck * 0.55);
  const head = joint(body, 0, 0.45, 0.3);
  ebox(head, -0.16, 0, 0, 0.16, 0.18, 0.24, PAL.chitinD);
  for (const s of [-1, 1]) ebox(head, s * 0.05 - 0.03, 0.12, 0.24, s * 0.05 + 0.03, 0.16, 0.25, PAL.eyeY, 1);
  const jaw = joint(head, 0, 0.02, 0.02, ck * 0.7);
  ebox(jaw, -0.14, -0.08, 0, 0.14, 0, 0.22, PAL.chitin);
  if (ck > 0) ebox(jaw, -0.07, -0.02, 0.08, 0.07, 0.01, 0.2, PAL.acid, 1);
  for (let k = 0; k < 6; k++) { // three legs a side, rippling in turn
    const s = k < 3 ? -1 : 1, z = -0.3 + (k % 3) * 0.25;
    const lift = Math.sin(e.phase + k * 2.1) * 0.45 * e.walkAmt;
    const leg = XF.chain(base, XF.t(s * 0.2, 0.46, z), XF.rx(lift), XF.rz(s * 0.9));
    ebox(leg, -0.035, -0.5, -0.035, 0.035, 0, 0.035, PAL.chitinD);
  }
}
// warden: a jailer in plate behind a tower shield; the shield swings aside when it bashes you with the mace
function drawWarden(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt, leg = 0.55 * sw;
  const swing = e.atk > 0 ? 1 - e.atk / e.atkMax : e.strike > 0 ? 1 : 0;
  for (const s of [-1, 1]) {
    const l = joint(base, s * 0.15, 0.85, 0, s * leg);
    ebox(l, -0.1, -0.85, -0.1, 0.1, 0, 0.1, PAL.plateD);
    ebox(l, -0.12, -0.85, -0.12, 0.12, -0.7, 0.16, PAL.plate);
  }
  const torso = joint(base, 0, 0.85, 0, 0.06);
  ebox(torso, -0.29, 0, -0.19, 0.29, 0.72, 0.19, PAL.plate);
  ebox(torso, -0.17, -0.12, 0.19, 0.17, 0.55, 0.22, PAL.tabard);
  ebox(torso, -0.33, 0.55, -0.21, 0.33, 0.72, 0.21, PAL.plateD);
  const head = joint(torso, 0, 0.72, 0.02);
  ebox(head, -0.16, 0, -0.16, 0.16, 0.34, 0.17, PAL.plate);
  ebox(head, -0.11, 0.15, 0.17, 0.11, 0.19, 0.18, PAL.visor, 1);
  ebox(head, -0.02, 0.34, -0.12, 0.02, 0.44, 0.12, PAL.tabard);
  // shield arm (left), out of the way during the swing
  const sh = XF.chain(torso, XF.t(-0.2, 0.32, 0.3), XF.ry(-1.3 * swing), XF.t(-0.05 * swing, 0, 0));
  ebox(sh, -0.3, -0.62, 0, 0.3, 0.5, 0.07, PAL.shield);
  ebox(sh, -0.32, -0.64, -0.01, 0.32, -0.54, 0.08, PAL.plateD);
  ebox(sh, -0.32, 0.42, -0.01, 0.32, 0.52, 0.08, PAL.plateD);
  cbox(sh, [0, -0.05, 0.08], [0.09, 0.09, 0.025], PAL.brass);
  // mace arm (right)
  const arm = joint(torso, 0.36, 0.62, 0, armPose(e, -0.2 - sw * 0.3, -2.7, -0.7));
  ebox(arm, -0.08, -0.58, -0.08, 0.08, 0, 0.08, PAL.plateD);
  ebox(arm, -0.025, -0.95, -0.025, 0.025, -0.55, 0.025, PAL.shield);
  cbox(arm, [0, -1.0, 0], [0.09, 0.09, 0.09], PAL.plate);
  for (const [x, z] of [[0.11, 0], [-0.11, 0], [0, 0.11], [0, -0.11]]) cbox(arm, [x, -1.0, z], [0.03, 0.03, 0.03], PAL.plateD);
}
// gorehorn: a shaggy, horned beast on four legs; it drops its head and paws the floor before it charges, and
// stands swaying with stars round its head if it runs into a wall
function drawGorehorn(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt, wind = e.rushWind > 0 ? 1 - e.rushWind / e.rushWindMax : 0;
  const lower = e.rush > 0 ? 1 : wind; // head down to charge
  const body = XF.mul(base, XF.rz(e.stun > 0 ? Math.sin(time * 9) * 0.08 : 0));
  ebox(body, -0.32, 0.6, -0.55, 0.32, 1.12, 0.4, PAL.fur);
  ebox(body, -0.28, 1.08, -0.15, 0.28, 1.38, 0.38, PAL.furD);                         // shoulder hump
  ebox(body, -0.03, 0.9, -0.62, 0.03, 1.02, -0.55, PAL.furD);                         // tail
  for (const [s, z, k] of [[-1, 0.28, 0], [1, 0.28, 1], [-1, -0.42, 1], [1, -0.42, 0]]) {
    let a = (k ? 1 : -1) * sw * 0.7;
    if (wind > 0 && s > 0 && z > 0) a = -0.5 + Math.sin(time * 16) * 0.5;             // pawing
    const leg = joint(body, s * 0.2, 0.68, z, a);
    ebox(leg, -0.08, -0.6, -0.08, 0.08, 0, 0.08, PAL.furD);
    ebox(leg, -0.09, -0.68, -0.09, 0.09, -0.56, 0.1, PAL.hoof);
  }
  const head = joint(body, 0, 0.95, 0.38, lerp(armPose(e, 0.1, -0.5, 0.7), 0.75, lower));
  ebox(head, -0.19, -0.2, 0, 0.19, 0.18, 0.36, PAL.fur);
  ebox(head, -0.13, -0.24, 0.32, 0.13, 0.02, 0.48, PAL.furD);                         // snout
  for (const s of [-1, 1]) {
    ebox(head, s * 0.07 - 0.03, 0.04, 0.36, s * 0.07 + 0.03, 0.09, 0.37, PAL.eyeR, 1);
    ebox(head, Math.min(s * 0.17, s * 0.4), 0.06, 0.06, Math.max(s * 0.17, s * 0.4), 0.15, 0.16, PAL.horn);
    ebox(head, Math.min(s * 0.32, s * 0.4), 0.06, 0.16, Math.max(s * 0.32, s * 0.4), 0.14, 0.5, PAL.horn);
    ebox(head, Math.min(s * 0.33, s * 0.39), 0.07, 0.5, Math.max(s * 0.33, s * 0.39), 0.25, 0.56, PAL.tusk);
  }
  if (e.stun > 0) for (let k = 0; k < 3; k++) { // dazed
    const a = time * 4 + k * 2.09;
    cbox(body, [Math.sin(a) * 0.32, 1.62, 0.3 + Math.cos(a) * 0.32], [0.045, 0.045, 0.045], PAL.eyeY, 1);
  }
}
// shade: a hooded wraith with no legs, drifting just off the floor, its rags trailing; long claws reach as it strikes
function drawShade(e, base) {
  const body = XF.mul(base, XF.rz(Math.sin(time * 1.7 + e.phase) * 0.06));
  for (let k = 0; k < 4; k++) { // trailing rags
    const rag = joint(body, -0.13 + k * 0.087, 0.36, (k % 2) * 0.05 - 0.04, Math.sin(time * 3 + k * 1.3) * 0.25 - 0.15);
    ebox(rag, -0.04, -0.38 - (k % 2) * 0.1, -0.03, 0.04, 0, 0.03, PAL.shroudD, 0.12);
  }
  ebox(body, -0.18, 0.3, -0.14, 0.18, 0.72, 0.14, PAL.shroudD, 0.12);
  ebox(body, -0.24, 0.68, -0.17, 0.24, 1.12, 0.17, PAL.shroud, 0.15);
  ebox(body, -0.28, 1.04, -0.19, 0.28, 1.2, 0.19, PAL.shroud, 0.15);
  const head = joint(body, 0, 1.16, 0.03, -0.1);
  ebox(head, -0.17, 0, -0.17, 0.17, 0.36, 0.17, PAL.shroudD, 0.12);
  ebox(head, -0.1, 0.33, -0.2, 0.1, 0.42, 0.02, PAL.shroudD, 0.12);                   // hood peak
  ebox(head, -0.12, 0.04, 0.17, 0.12, 0.27, 0.18, PAL.void);
  for (const s of [-1, 1]) ebox(head, s * 0.06 - 0.03, 0.15, 0.18, s * 0.06 + 0.03, 0.19, 0.19, PAL.wisp, 1);
  for (const s of [-1, 1]) {
    const arm = joint(body, s * 0.3, 1.1, 0, armPose(e, -0.5 + Math.sin(time * 2 + s) * 0.1, -2.3, -0.9));
    ebox(arm, -0.06, -0.55, -0.06, 0.06, 0, 0.06, PAL.shroud, 0.15);
    for (const f of [-1, 0, 1]) ebox(arm, f * 0.035 - 0.012, -0.8, -0.012, f * 0.035 + 0.012, -0.55, 0.012, PAL.bone);
  }
}
// gravecaller: a hunched, skull-faced priest with a tall hood and a staff; it lifts the staff and the dead climb up
function drawGravecaller(e, base) {
  const sw = Math.sin(e.phase) * e.walkAmt, ck = e.cast > 0 ? 1 - e.cast / e.castMax : 0;
  const body = XF.mul(base, XF.rz(sw * 0.05));
  ebox(body, -0.3, 0, -0.26, 0.3, 0.55, 0.26, PAL.graveD);
  ebox(body, -0.32, 0.02, -0.28, 0.32, 0.1, 0.28, PAL.boneD);
  const torso = joint(body, 0, 0.55, 0, 0.18 - ck * 0.15);
  ebox(torso, -0.26, 0, -0.2, 0.26, 0.72, 0.2, PAL.grave);
  for (const y of [0.3, 0.42, 0.54]) ebox(torso, -0.14, y, 0.2, 0.14, y + 0.05, 0.22, PAL.bone);   // ribs
  const head = joint(torso, 0, 0.72, 0.04, 0.1);
  ebox(head, -0.2, 0, -0.2, 0.2, 0.36, 0.2, PAL.graveD);
  ebox(head, -0.13, 0.34, -0.17, 0.13, 0.54, 0.06, PAL.graveD);
  ebox(head, -0.06, 0.52, -0.15, 0.06, 0.66, -0.04, PAL.graveD);                      // the hood's point
  ebox(head, -0.13, 0.03, 0.19, 0.13, 0.28, 0.21, PAL.bone);                          // skull face
  for (const s of [-1, 1]) ebox(head, s * 0.06 - 0.03, 0.15, 0.21, s * 0.06 + 0.03, 0.2, 0.22, PAL.soul, 1);
  // staff arm (right): raised overhead to call up the dead
  const arm = joint(torso, 0.32, 0.64, 0, lerp(-0.35 - sw * 0.3, -2.5, Math.min(1, ck * 2)));
  ebox(arm, -0.08, -0.55, -0.08, 0.08, 0, 0.08, PAL.grave);
  ebox(arm, -0.03, -1.15, 0.1, 0.03, 0.45, 0.16, PAL.shield);
  cbox(arm, [0, 0.55, 0.13], [0.09, 0.09, 0.09], PAL.bone);
  cbox(arm, [0, 0.72, 0.13], [0.05, 0.08, 0.05], PAL.soul, 0.5 + ck * 0.5);
  // the free hand reaches toward the ground as it calls
  const off = joint(torso, -0.32, 0.64, 0, lerp(-0.25 + sw * 0.3, -1.1, ck));
  ebox(off, -0.08, -0.55, -0.08, 0.08, 0, 0.08, PAL.grave);
  ebox(off, -0.06, -0.68, -0.05, 0.06, -0.55, 0.07, PAL.bone, ck * 0.4);
}
function drawEnemy(e) {
  if (e.dead && e.deadT > 2.5) return;
  E.L = getL(Math.floor(e.x), Math.floor(e.y + liftOf(e) + 1), Math.floor(e.z)) / 15;
  E.flash = e.hurt > 0;
  let base = XF.mul(XF.t(e.x, e.y + liftOf(e), e.z), XF.ry(e.yaw));
  if (e.dead) { // topple backwards, then sink away
    const k = Math.min(1, e.deadT / 0.4);
    base = XF.chain(base, XF.t(0, -Math.max(0, e.deadT - 0.5) * 1.2, 0), XF.rx(-k * 1.45));
  }
  if (e.type === 'ghoul') drawGhoul(e, base);
  else if (e.type === 'cultist') drawCultist(e, base);
  else if (e.type === 'bat') drawBat(e, base);
  else if (e.type === 'bloater') drawBloater(e, base);
  else if (e.type === 'spitter') drawSpitter(e, base);
  else if (e.type === 'warden') drawWarden(e, base);
  else if (e.type === 'gorehorn') drawGorehorn(e, base);
  else if (e.type === 'shade') drawShade(e, base);
  else if (e.type === 'gravecaller') drawGravecaller(e, base);
  else drawBrute(e, base, e.type === 'boss');
  E.flash = false;
}
function drawPortal() {
  if (!exitPos) return;
  const open = !bossAlive();
  E.L = 1; E.flash = false;
  const nx = 4, ny = 9, x0 = exitPos[0] - 0.08, w = 1.16, y0 = FY + 1, h = 3.0, zc = exitPos[1] + 0.5;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const u = (i + 0.5) / nx * 2 - 1, v = (j + 0.5) / ny * 2 - 1;
    const r = Math.hypot(u * 0.7, v), ang = Math.atan2(v, u);
    const s = 0.5 + 0.5 * Math.sin(time * 2.6 - r * 5 + ang * 2);
    const col = open ? mix3(mix3([0.4, 0.18, 0.85], [1, 0.78, 0.4], s * s), [1, 0.97, 0.9], portalBoost * 0.6) : mix3([0.12, 0.02, 0.02], [0.45, 0.07, 0.04], s * (0.6 + 0.4 * Math.sin(time * 1.5)));
    ebox(XF.id(), x0 + i * w / nx, y0 + j * h / ny, zc - 0.03, x0 + (i + 1) * w / nx, y0 + (j + 1) * h / ny, zc + 0.03, col, open ? 1 : 0.6);
  }
}
function buildWorldEntities(cam) {
  EM.v.length = 0; EM.i.length = 0;
  for (const e of enemies) drawEnemy(e);
  E.flash = false;
  for (const f of fireballs) {
    E.L = 1;
    const xf = XF.chain(XF.t(f.x, f.y, f.z), XF.ry(time * 8), XF.rx(time * 6));
    if (f.acid) {
      ebox(xf, -0.11, -0.11, -0.11, 0.11, 0.11, 0.11, PAL.acid, 0.8);
      ebox(xf, -0.07, -0.13, -0.07, 0.07, 0.13, 0.07, [0.8, 1, 0.5], 0.8);
    } else {
      ebox(xf, -0.14, -0.14, -0.14, 0.14, 0.14, 0.14, PAL.ember, 1);
      ebox(xf, -0.09, -0.09, -0.17, 0.09, 0.09, 0.17, [1, 0.85, 0.5], 1);
    }
  }
  for (const p of pools) { // a cross of thin slabs reads as a rough puddle; it shrinks away as it dries
    const r = p.r * Math.min(1, p.t), y = FY + 1.06, wob = Math.sin(time * 2 + p.x) * 0.03;
    E.L = getL(Math.floor(p.x), FY + 1, Math.floor(p.z)) / 15;
    ebox(XF.id(), p.x - r, y, p.z - r * 0.55, p.x + r, y + 0.02, p.z + r * 0.55, [0.09, 0.15, 0.05], 0.1 + wob);
    ebox(XF.id(), p.x - r * 0.55, y, p.z - r, p.x + r * 0.55, y + 0.02, p.z + r, [0.09, 0.15, 0.05], 0.1 + wob);
    ebox(XF.id(), p.x - r * 0.35, y + 0.005, p.z - r * 0.35, p.x + r * 0.35, y + 0.03, p.z + r * 0.35, [0.2, 0.36, 0.08], 0.3);
  }
  for (const p of pickups) {
    E.L = getL(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) / 15;
    const xf = XF.chain(XF.t(p.x, p.y + Math.sin(p.t * 3) * 0.1, p.z), XF.ry(p.t * 2), XF.rz(Math.PI / 4), XF.rx(Math.PI / 4));
    ebox(xf, -0.11, -0.11, -0.11, 0.11, 0.11, 0.11, [0.95, 0.15, 0.22], 0.7);
  }
  for (const p of particles) {
    // a mote right against the lens just reads as a blob
    if (Math.abs(p.x - cam[0]) + Math.abs(p.y - cam[1]) + Math.abs(p.z - cam[2]) < 0.9) continue;
    E.L = getL(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) / 15;
    const s = p.size;
    ebox(XF.id(), p.x - s, p.y - s, p.z - s, p.x + s, p.y + s, p.z + s, p.col, p.em);
  }
  drawPortal();
}
// the revolver, built in view space (x right, y up, looking down -z)
function buildGun() {
  EM.v.length = 0; EM.i.length = 0;
  E.L = getL(Math.floor(P.x), Math.floor(P.y + P.eye), Math.floor(P.z)) / 15; E.flash = false;
  const hs = Math.min(1, Math.hypot(P.vx, P.vz) / 4.3) * (P.onGround && OPT.motion ? 1 : 0);
  const bx = Math.cos(gunBob) * 0.006 * hs, by = -Math.abs(Math.sin(gunBob)) * 0.008 * hs;
  const rp = reloadT > 0 ? 1 - reloadT / GUN.reload : 0, dip = Math.sin(Math.PI * rp);
  const drop = state === 'dying' ? clamp01(deathT / 0.6) ** 2 : 0; // the gun slips from your hand as you fall
  const xf = XF.chain(
    XF.t(0.15 + bx + 0.1 * drop, -0.15 + by - 0.05 * gunSprint - 0.1 * dip - 0.55 * drop, -0.36 + 0.04 * recoil),
    XF.ry(0.1),
    XF.rx(0.22 * recoil - 0.4 * gunSprint + 0.35 * dip - 1.1 * drop),
    XF.rz(0.8 * dip));
  const wood = [0.36, 0.2, 0.1], iron = [0.2, 0.2, 0.22], steel = [0.32, 0.32, 0.35], brass = [0.78, 0.58, 0.22];
  cbox(xf, [0, -0.1, 0.16], [0.045, 0.045, 0.08], [0.2, 0.13, 0.1]);  // sleeve (runs off the bottom of the screen)
  cbox(xf, [0, -0.07, 0.05], [0.038, 0.042, 0.045], [0.55, 0.4, 0.3]); // hand
  cbox(xf, [0, -0.045, 0.035], [0.02, 0.042, 0.026], wood);           // grip
  cbox(xf, [0, 0, -0.02], [0.024, 0.028, 0.075], iron);               // frame
  cbox(xf, [0, 0.002, -0.045], [0.034, 0.034, 0.032], steel);         // cylinder
  for (const s of [-1, 1]) cbox(xf, [s * 0.034, 0.002, -0.045], [0.002, 0.03, 0.008], [0.14, 0.14, 0.16]); // flutes
  cbox(xf, [0, 0.012, -0.17], [0.015, 0.015, 0.1], iron);             // barrel
  cbox(xf, [0, 0.012, -0.265], [0.02, 0.02, 0.009], brass);           // muzzle ring
  cbox(xf, [0, 0.031, -0.25], [0.004, 0.007, 0.007], brass);          // front sight
  cbox(xf, [0, 0.036, 0.042], [0.007, 0.014, 0.011], iron);           // hammer
  cbox(xf, [0, -0.034, -0.002], [0.007, 0.009, 0.022], brass);        // trigger guard
  if (muzzleT > 0) {
    const k = muzzleT / 0.07, m = XF.mul(XF.mul(xf, XF.t(0, 0.012, -0.3)), XF.rz(muzzleRot));
    const c = [1, 0.85, 0.5];
    ebox(m, -0.08 * k, -0.012, -0.03, 0.08 * k, 0.012, 0.03, c, 1);
    ebox(m, -0.012, -0.08 * k, -0.03, 0.012, 0.08 * k, 0.03, c, 1);
    ebox(m, -0.03, -0.03, -0.12 * k, 0.03, 0.03, 0.02, [1, 0.95, 0.8], 1);
  }
}

// rendering
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
}
window.addEventListener('resize', resize);

const ptA = new Float32Array(32), ptC = new Float32Array(24);
function setLights(U, list) {
  const n = Math.min(8, list.length);
  for (let k = 0; k < n; k++) { const l = list[k]; ptA.set(l.slice(0, 4), k * 4); ptC.set(l.slice(4, 7), k * 3); }
  gl.uniform4fv(U['uPts[0]'], ptA); gl.uniform3fv(U['uPtC[0]'], ptC); gl.uniform1i(U.uPtsN, n);
}

let time = 0;
function render() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.016, 0.012, 0.018, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  // the camera is yours, except while you fall (it rolls) and during the ending (it flies on its own)
  const view = state === 'cine' ? cineCamera(cineT)
    : { pos: eyePos(), yaw: P.yaw, pitch: P.pitch, roll: state === 'dying' || state === 'dead' ? deathRoll() : 0 };
  const cam = view.pos;
  const aspect = canvas.width / canvas.height;
  const proj = M4.persp(OPT.fov * Math.PI / 180, aspect, 0.05, 200);
  const vp = M4.mul(proj, M4.view(cam, view.yaw, view.pitch, view.roll));
  const { r, u, f } = M4.basis(view.yaw, view.pitch, view.roll);
  // the lantern stays in your hand; in the ending it hangs back so the hall reads by its own light
  const lamp = state === 'cine' ? [0, 0, -1000] : [0, 1, 2].map(a => cam[a] + r[a] * 0.35 - u[a] * 0.3 + f[a] * 0.2);

  // moving lights, nearest first
  const lights = [];
  if (muzzleT > 0) lights.push([0, 1, 2].map(a => cam[a] + f[a] * 0.7 + r[a] * 0.2 - u[a] * 0.15).concat(3 * muzzleT / 0.07, 1, 0.75, 0.4));
  for (const b of fireballs) lights.push(b.acid ? [b.x, b.y, b.z, 1.0, 0.45, 1, 0.2] : [b.x, b.y, b.z, 1.6, 1, 0.5, 0.18]);
  for (const b of blasts) lights.push([b.x, b.y, b.z, 6 * b.t / 0.4, 1, 0.6, 0.25]);
  if (exitPos) {
    const open = !bossAlive();
    lights.push([exitPos[0] + 0.5, FY + 2.5, exitPos[1] + 0.5, open ? 1.8 + portalBoost * 3 : 0.9,
      open ? 0.6 + portalBoost * 0.4 : 1, open ? 0.35 + portalBoost * 0.45 : 0.15, open ? 1 : 0.08]);
  }
  if (bossAlive()) lights.push([boss.x, boss.y + 2.4, boss.z, 0.9, 1, 0.45, 0.12]);
  for (const p of pickups) lights.push([p.x, p.y, p.z, 0.5, 1, 0.2, 0.25]);
  const d2 = l => (l[0] - cam[0]) ** 2 + (l[1] - cam[1]) ** 2 + (l[2] - cam[2]) ** 2;
  lights.sort((a, b) => d2(a) - d2(b));

  gl.useProgram(blockProg.p);
  const U = blockProg.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
  gl.uniform1i(U.uTex, 0);
  gl.uniformMatrix4fv(U.uMVP, false, vp);
  gl.uniform3fv(U.uCam, cam);
  gl.uniform3fv(U.uLamp, lamp);
  gl.uniform1f(U.uTime, time);
  gl.uniform1f(U.uLava, T.lava);
  gl.uniform1f(U.uTorch, T.torch);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  setLights(U, lights);
  for (const m of chunkMeshes) {
    if (!m || !m.count) continue;
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
  }

  // creatures, fireballs, particles, the portal
  buildWorldEntities(cam);
  const EU = entProg.u;
  gl.useProgram(entProg.p);
  gl.uniform2f(EU.uRes, canvas.width, canvas.height);
  if (EM.i.length) {
    gl.uniformMatrix4fv(EU.uMVP, false, vp);
    gl.uniform3fv(EU.uCam, cam);
    gl.uniform3fv(EU.uLamp, lamp);
    setLights(EU, lights);
    uploadMesh(entMesh, EM, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(entMesh.vao);
    gl.drawElements(gl.TRIANGLES, entMesh.count, gl.UNSIGNED_INT, 0);
  }

  // halos: camera-facing quads, pulled toward the camera so they don't slice into the wall behind
  const v = [];
  const halo = (x, y, z, R, phase, col) => {
    const dx = cam[0] - x, dy = cam[1] - y, dz = cam[2] - z, d = Math.hypot(dx, dy, dz);
    if (d > 40 || d < 0.1) return;
    const k = Math.min(0.5, d * 0.5) / d, c = [x + dx * k, y + dy * k, z + dz * k];
    for (const n of [0, 1, 2, 0, 2, 3]) {
      const [su, sv] = CORNERS[n];
      v.push(c[0] + (r[0] * su + u[0] * sv) * R, c[1] + (r[1] * su + u[1] * sv) * R,
        c[2] + (r[2] * su + u[2] * sv) * R, (su + 1) / 2, (sv + 1) / 2, phase, col[0], col[1], col[2]);
    }
  };
  for (const fl of flames) halo(fl[0], fl[1], fl[2], 0.75, fl[3], [1, 0.55, 0.22]);
  for (const b of fireballs) halo(b.x, b.y, b.z, b.acid ? 0.7 : 1.0, 0, b.acid ? [0.4, 0.9, 0.15] : [1, 0.5, 0.15]);
  for (const b of blasts) halo(b.x, b.y, b.z, 3.5 * b.t / 0.4 + 0.5, 0, [1, 0.55, 0.2]);
  for (const p of pickups) halo(p.x, p.y, p.z, 0.6, p.t, [1, 0.2, 0.3]);
  if (exitPos) halo(exitPos[0] + 0.5, FY + 2.5, exitPos[1] + 0.5, 2.2 * (1 + portalBoost), 0,
    bossAlive() ? [0.6, 0.1, 0.05] : mix3([0.6, 0.35, 1], [1, 0.85, 0.6], portalBoost));
  if (v.length) {
    gl.useProgram(glowProg.p);
    gl.uniformMatrix4fv(glowProg.u.uMVP, false, vp);
    gl.uniform3fv(glowProg.u.uCam, cam);
    gl.uniform1f(glowProg.u.uTime, time);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    gl.bindVertexArray(glowMesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, glowMesh.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, v.length / 9);
    gl.depthMask(true); gl.disable(gl.BLEND);
  }

  // the gun, on top of everything, with its own narrower lens
  if (state === 'play' || (state === 'dying' && deathT < 0.7)) {
    gl.clear(gl.DEPTH_BUFFER_BIT);
    buildGun();
    gl.useProgram(entProg.p);
    gl.uniformMatrix4fv(EU.uMVP, false, M4.persp(60 * Math.PI / 180, aspect, 0.01, 10));
    gl.uniform3f(EU.uCam, 0, 0, 0);
    gl.uniform3f(EU.uLamp, -0.3, 0.45, 0.25);
    setLights(EU, muzzleT > 0 ? [[0.2, -0.17, -0.85, 2.5 * muzzleT / 0.07, 1, 0.75, 0.4]] : []);
    uploadMesh(gunMesh, EM, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(gunMesh.vao);
    gl.drawElements(gl.TRIANGLES, gunMesh.count, gl.UNSIGNED_INT, 0);
  }
  gl.bindVertexArray(null);
}

// main loop
const worldRuns = () => state === 'play' || state === 'dying' || state === 'cine';
function step(dt) {
  if (state === 'play') {
    updatePlayer(dt);
    if (state === 'play') updateGun(dt);
  }
  if (!worldRuns()) return;
  updateFlow();
  for (const e of enemies) updateEnemy(e, dt);
  // bodies don't overlap: creatures shove each other, and the heavy ones shove you
  const live = enemies.filter(e => !e.dead);
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    for (let j = i + 1; j < live.length; j++) pushApart(a, live[j], 0.5);
    // being shoved about without touching the keys is disorienting, so creatures give way to you more than you to them
    if (state === 'play' && Math.abs(a.y - P.y) < Math.max(a.h, PH)) pushApart(a, P, a === boss ? 0.5 : a.type === 'brute' ? 0.6 : 0.85);
  }
  for (let k = enemies.length - 1; k >= 0; k--) if (enemies[k].dead && enemies[k].deadT > 1 && enemies[k] !== boss) enemies.splice(k, 1);
  updateFireballs(dt);
  if (state === 'play') updatePools(dt);
  for (let k = blasts.length - 1; k >= 0; k--) if ((blasts[k].t -= dt) <= 0) blasts.splice(k, 1);
  updatePickups(dt);
  updateParticles(dt);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now; time += dt;
  if ((state === 'play' && locked) || state === 'dying' || state === 'cine') {
    if (state === 'play') { levelTime += dt; totalTime += dt; }
    else if (state === 'dying') updateDeath(dt);
    else updateCutscene(dt);
    let rem = dt;
    while (rem > 1e-6 && worldRuns()) { const s = Math.min(rem, 1 / 120); step(s); rem -= s; }
  }
  if (ready) updateHudLive();
  render();
  requestAnimationFrame(frame);
}

async function start() {
  try {
    await loadText();
  } catch (err) {
    // text.json itself can't be read (usually the page was opened as a file), so this is the one fallback
    statusEl.textContent = 'Could not load text.json - run: python3 -m http.server 8000 and open http://localhost:8000';
    return;
  }
  buildMenu();
  $('title').textContent = TEXT.title;
  statusEl.textContent = TEXT.loading;
  if (!gl) { statusEl.textContent = TEXT.messages.noWebGL; return; }
  try {
    await loadTextures();
  } catch (err) {
    console.error(err);
    statusEl.textContent = location.protocol === 'file:' ? TEXT.messages.fileProtocol : fmt(TEXT.messages.loadFailed, { error: err.message });
    return;
  }
  await document.fonts.load(`16px PixelFont`).catch(() => {});
  blockProg = compile(BLOCK_VS, BLOCK_FS);
  glowProg = compile(GLOW_VS, GLOW_FS);
  entProg = compile(ENT_VS, ENT_FS);
  glowMesh = makeMesh([[0, 3], [1, 3], [2, 3]]);
  entMesh = makeMesh([[0, 3], [1, 3], [2, 3], [3, 2]]);
  gunMesh = makeMesh([[0, 3], [1, 3], [2, 3], [3, 2]]);

  resize();
  loadLevel(START_LEVEL);
  ready = true;
  setState('menu');
  updateOverlay();
  requestAnimationFrame(frame);
}
start();
