'use strict';
(function () {

// DOM & settings
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const canvas = $('#gl');
const ui = {
  fade: $('#fade'), flash: $('#flash'), hud: $('#hud'), hotbar: $('#hotbar'), itemName: $('#itemName'),
  toast: $('#toast'), crosshair: $('#crosshair'), click: $('#clickToPlay'),
  loadMsg: $('#loadMsg'), loadBar: $('#loadBar > i'), errorMsg: $('#errorMsg'),
  btnContinue: $('#btnContinue'), btnReset: $('#btnReset'), playNote: $('#playNote'), pauseNote: $('#pauseNote'), binds: $('#binds'),
};

// the only controls in the game (all rebindable)
const ACTIONS = [
  ['forward', 'Walk Forward'], ['back', 'Walk Backward'], ['left', 'Walk Left'], ['right', 'Walk Right'],
  ['jump', 'Jump'], ['sprint', 'Sprint'], ['break', 'Remove Block'], ['place', 'Place Block'], ['reset', 'Reset Position'],
];
const DEFAULTS = {
  sens: 1, fov: 75, renderDist: 160, volume: 70, bob: true, invertY: false,
  binds: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sprint: 'ShiftLeft', break: 'Mouse0', place: 'Mouse2', reset: 'KeyR' },
};
const SETTINGS_KEY = 'mineplace.settings.v2';
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { s = {}; }
  const out = Object.assign({}, DEFAULTS, s);
  out.binds = Object.assign({}, DEFAULTS.binds, s.binds || {});
  return out;
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = t => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

// Math (column-major 4x4 matrices)
const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  persp(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / aspect; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f);
    return m;
  },
  lookAt(e, c, u) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const m = new Float32Array(16);
    m[0] = xx; m[1] = yx; m[2] = zx;
    m[4] = xy; m[5] = yy; m[6] = zy;
    m[8] = xz; m[9] = yz; m[10] = zz;
    m[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
    m[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
    m[14] = -(zx * e[0] + zy * e[1] + zz * e[2]);
    m[15] = 1;
    return m;
  },
  translate(x, y, z) { const m = M4.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
  scale(x, y = x, z = x) { const m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; },
  rotX(a) { const c = Math.cos(a), s = Math.sin(a), m = M4.ident(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
  rotY(a) { const c = Math.cos(a), s = Math.sin(a), m = M4.ident(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
  rotZ(a) { const c = Math.cos(a), s = Math.sin(a), m = M4.ident(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  chain(...ms) { return ms.reduce((a, b) => M4.mul(a, b)); },
};
function frustumPlanes(m) {
  const p = [];
  for (let i = 0; i < 3; i++) for (const s of [1, -1]) {
    p.push([m[3] + s * m[i], m[7] + s * m[4 + i], m[11] + s * m[8 + i], m[15] + s * m[12 + i]]);
  }
  return p;
}
function boxVisible(planes, x0, y0, z0, x1, y1, z1) {
  for (const p of planes) {
    if (p[0] * (p[0] > 0 ? x1 : x0) + p[1] * (p[1] > 0 ? y1 : y0) + p[2] * (p[2] > 0 ? z1 : z0) + p[3] < 0) return false;
  }
  return true;
}

// Random & noise (Hills & Caves terrain)
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y, s, oct) {
  let sum = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * noise2(x * f, y * f, s + i * 101); norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}

// Pixel font — bitmap glyphs compiled into a real TrueType font at runtime
// Rows 0-6 sit on the baseline, row 7 is the descender. '#' = pixel on.
const GLYPH_DATA = {
  '!': '#/#/#/#/#/./#', '"': '#.#/#.#', '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  '$': '..#../.####/#..../.###./....#/####./..#..', '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '&': '.#.../#.#../.#.../#.#.#/#..#./#..#./.##.#', "'": '#/#', '(': '..#/.#./#../#../#../.#./..#',
  ')': '#../.#./..#/..#/..#/.#./#..', '*': '...../..#../#.#.#/.###./#.#.#/..#..', '+': '...../..#../..#../#####/..#../..#..',
  ',': './././././#/#/#', '-': '...../...../...../#####', '.': './././././././#', '/': '....#/...#./...#./..#../.#.../.#.../#....',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.', '1': '..#../.##../..#../..#../..#../..#../#####',
  '2': '.###./#...#/....#/..##./.#.../#..../#####', '3': '.###./#...#/....#/..##./....#/#...#/.###.',
  '4': '...##/..#.#/.#..#/#...#/#####/....#/....#', '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.', '7': '#####/#...#/....#/...#./..#../..#../..#..',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.', '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  ':': './#/././././#', ';': './#/././././#/#', '<': '...#/..#./.#../#.../.#../..#./...#', '=': '...../...../#####/...../#####',
  '>': '#.../.#../..#./...#/..#./.#../#...', '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.####',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#', B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.', D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####', F: '#####/#..../#..../####./#..../#..../#....',
  G: '.####/#..../#..../#..##/#...#/#...#/.###.', H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '###/.#./.#./.#./.#./.#./###', J: '....#/....#/....#/....#/....#/#...#/.###.',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#', L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#...#/#...#/#...#/#...#', N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.', P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', R: '####./#...#/#...#/####./#..#./#...#/#...#',
  S: '.####/#..../#..../.###./....#/....#/####.', T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.', V: '#...#/#...#/#...#/#...#/.#.#./.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..', Z: '#####/....#/...#./..#../.#.../#..../#####',
  '[': '###/#../#../#../#../#../###', '\\': '#..../.#.../.#.../..#../...#./...#./....#', ']': '###/..#/..#/..#/..#/..#/###',
  '^': '..#../.#.#./#...#', '_': '...../...../...../...../...../...../...../#####', '`': '#./.#',
  a: '...../...../.###./....#/.####/#...#/.####', b: '#..../#..../#.##./##..#/#...#/#...#/####.',
  c: '...../...../.###./#...#/#..../#...#/.###.', d: '....#/....#/.##.#/#..##/#...#/#...#/.####',
  e: '...../...../.###./#...#/#####/#..../.####', f: '..##/.#../####/.#../.#../.#../.#..',
  g: '...../...../.####/#...#/#...#/.####/....#/####.', h: '#..../#..../#.##./##..#/#...#/#...#/#...#',
  i: '#/./#/#/#/#/#', j: '..#/.../..#/..#/..#/..#/..#/##.', k: '#.../#.../#..#/#.#./##../#.#./#..#',
  l: '#./#./#./#./#./#./.#', m: '...../...../##.#./#.#.#/#.#.#/#...#/#...#', n: '...../...../####./#...#/#...#/#...#/#...#',
  o: '...../...../.###./#...#/#...#/#...#/.###.', p: '...../...../#.##./##..#/#...#/####./#..../#....',
  q: '...../...../.##.#/#..##/#...#/.####/....#/....#', r: '...../...../#.##./##..#/#..../#..../#....',
  s: '...../...../.####/#..../.###./....#/####.', t: '.#../.#../####/.#../.#../.#../..##',
  u: '...../...../#...#/#...#/#...#/#...#/.####', v: '...../...../#...#/#...#/#...#/.#.#./..#..',
  w: '...../...../#...#/#...#/#.#.#/#.#.#/.####', x: '...../...../#...#/.#.#./..#../.#.#./#...#',
  y: '...../...../#...#/#...#/#...#/.####/....#/####.', z: '...../...../#####/...#./..#../.#.../#####',
  '{': '..##/.#../.#../#.../.#../.#../..##', '|': '#/#/#/#/#/#/#/#', '}': '##../..#./..#./...#/..#./..#./##..',
  '~': '...../...../.#.../#.#.#/...#.', '°': '.#./#.#/.#.', '·': '././././#', '…': '...../...../...../...../...../...../#.#.#',
  '→': '...../..#../...#./#####/...#./..#..', '←': '...../..#../.#.../#####/.#.../..#..',
};
function buildPixelFont(family) {
  const PX = 128, EM = 1024, ASC = 1024, DESC = 256;
  const bytes = [];
  const W = {
    u8: v => bytes.push(v & 255), u16: v => { bytes.push((v >> 8) & 255, v & 255); },
    i16: v => W.u16(v < 0 ? v + 65536 : v), u32: v => { W.u16((v >>> 16) & 65535); W.u16(v & 65535); },
  };
  const tableBytes = (fn) => { const start = bytes.length; fn(); const t = bytes.splice(start); t.len = t.length; while (t.length % 4) t.push(0); return t; };
  // glyph 0 = .notdef (empty), glyph 1 = space
  const glyphs = [{ code: -1, adv: 4 * PX, rects: [] }, { code: 32, adv: 4 * PX, rects: [] }];
  for (const ch of Object.keys(GLYPH_DATA).sort((a, b) => a.codePointAt(0) - b.codePointAt(0))) {
    const rows = GLYPH_DATA[ch].split('/');
    let left = 99, right = -1;
    rows.forEach(r => { const a = r.indexOf('#'), b = r.lastIndexOf('#'); if (a >= 0) { left = Math.min(left, a); right = Math.max(right, b); } });
    const rects = []; let prev = {};
    rows.forEach((r, y) => {
      const cur = {};
      for (let x = 0; x < r.length; x++) {
        if (r[x] !== '#') continue;
        let x1 = x; while (r[x1 + 1] === '#') x1++;
        const key = x + ',' + x1;
        let rect = prev[key];
        if (rect) rect.r1 = y + 1; else { rect = { x0: x - left, x1: x1 + 1 - left, r0: y, r1: y + 1 }; rects.push(rect); }
        cur[key] = rect; x = x1;
      }
      prev = cur;
    });
    glyphs.push({ code: ch.codePointAt(0), adv: (right - left + 2) * PX, rects });
  }
  // glyf + loca
  let maxPts = 0, maxCont = 0, gx0 = 0, gy0 = 0, gx1 = 0, gy1 = 0;
  const offsets = [];
  const glyf = tableBytes(() => {
    const base = bytes.length;
    for (const g of glyphs) {
      offsets.push(bytes.length - base);
      if (!g.rects.length) continue;
      const pts = [];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const r of g.rects) {
        const L = r.x0 * PX, R = r.x1 * PX, T = (7 - r.r0) * PX, B = (7 - r.r1) * PX;
        pts.push([L, B], [L, T], [R, T], [R, B]); // clockwise
        x0 = Math.min(x0, L); x1 = Math.max(x1, R); y0 = Math.min(y0, B); y1 = Math.max(y1, T);
      }
      g.bbox = [x0, y0, x1, y1];
      gx0 = Math.min(gx0, x0); gy0 = Math.min(gy0, y0); gx1 = Math.max(gx1, x1); gy1 = Math.max(gy1, y1);
      maxPts = Math.max(maxPts, pts.length); maxCont = Math.max(maxCont, g.rects.length);
      W.i16(g.rects.length); W.i16(x0); W.i16(y0); W.i16(x1); W.i16(y1);
      for (let i = 0; i < g.rects.length; i++) W.u16(i * 4 + 3);
      W.u16(0);                         // no instructions
      for (let i = 0; i < pts.length; i++) W.u8(1); // on-curve, 16-bit deltas
      let px = 0; for (const p of pts) { W.i16(p[0] - px); px = p[0]; }
      let py = 0; for (const p of pts) { W.i16(p[1] - py); py = p[1]; }
      while ((bytes.length - base) % 4) W.u8(0);
    }
    offsets.push(bytes.length - base);
  });
  const loca = tableBytes(() => offsets.forEach(o => W.u32(o)));
  const n = glyphs.length;
  const head = tableBytes(() => {
    W.u32(0x00010000); W.u32(0x00010000); W.u32(0); W.u32(0x5F0F3CF5);
    W.u16(0x000B); W.u16(EM); W.u32(0); W.u32(0); W.u32(0); W.u32(0);
    W.i16(gx0); W.i16(gy0); W.i16(gx1); W.i16(gy1);
    W.u16(0); W.u16(8); W.i16(2); W.i16(1); W.i16(0);
  });
  const maxAdv = Math.max(...glyphs.map(g => g.adv));
  const hhea = tableBytes(() => {
    W.u32(0x00010000); W.i16(ASC); W.i16(-DESC); W.i16(0); W.u16(maxAdv);
    W.i16(0); W.i16(0); W.i16(gx1); W.i16(1); W.i16(0); W.i16(0);
    W.i16(0); W.i16(0); W.i16(0); W.i16(0); W.i16(0); W.u16(n);
  });
  const maxp = tableBytes(() => {
    W.u32(0x00010000); W.u16(n); W.u16(maxPts); W.u16(maxCont); W.u16(0); W.u16(0);
    W.u16(2); W.u16(0); W.u16(0); W.u16(0); W.u16(0); W.u16(0); W.u16(0); W.u16(0); W.u16(0);
  });
  const hmtx = tableBytes(() => glyphs.forEach(g => { W.u16(g.adv); W.i16(g.bbox ? g.bbox[0] : 0); }));
  const codes = glyphs.slice(1).map(g => g.code);
  const os2 = tableBytes(() => {
    W.u16(4); W.i16(6 * PX); W.u16(400); W.u16(5); W.u16(0);
    W.i16(EM * 0.6); W.i16(EM * 0.6); W.i16(0); W.i16(PX); W.i16(EM * 0.6); W.i16(EM * 0.6); W.i16(0); W.i16(3 * PX);
    W.i16(PX); W.i16(3 * PX); W.i16(0);
    for (let i = 0; i < 10; i++) W.u8(0);
    W.u32(0x80000003); W.u32(0); W.u32(0); W.u32(0);
    for (const c of 'NONE') W.u8(c.charCodeAt(0));
    W.u16(0xC0); W.u16(32); W.u16(Math.min(0xFFFF, Math.max(...codes)));
    W.i16(ASC); W.i16(-DESC); W.i16(0); W.u16(ASC); W.u16(DESC);
    W.u32(1); W.u32(0);
    W.i16(5 * PX); W.i16(7 * PX); W.u16(0); W.u16(32); W.u16(0);
  });
  const cmap = tableBytes(() => {
    // merge consecutive codes that map to consecutive glyph ids into segments
    const segs = [];
    glyphs.forEach((g, gid) => {
      if (g.code < 0) return;
      const last = segs[segs.length - 1];
      if (last && g.code === last.end + 1 && gid - g.code === last.delta) last.end = g.code;
      else segs.push({ start: g.code, end: g.code, delta: gid - g.code });
    });
    segs.push({ start: 0xFFFF, end: 0xFFFF, delta: 1 });
    const sc = segs.length, p2 = 2 ** Math.floor(Math.log2(sc));
    W.u16(0); W.u16(1); W.u16(3); W.u16(1); W.u32(12);
    W.u16(4); W.u16(16 + sc * 8); W.u16(0);
    W.u16(sc * 2); W.u16(p2 * 2); W.u16(Math.log2(p2)); W.u16(sc * 2 - p2 * 2);
    segs.forEach(s => W.u16(s.end)); W.u16(0);
    segs.forEach(s => W.u16(s.start));
    segs.forEach(s => W.u16((s.delta + 65536) % 65536));
    segs.forEach(() => W.u16(0));
  });
  const name = tableBytes(() => {
    const recs = [[1, family], [2, 'Regular'], [3, family + '-Regular'], [4, family], [6, family + '-Regular']];
    W.u16(0); W.u16(recs.length); W.u16(6 + recs.length * 12);
    let off = 0;
    for (const [id, s] of recs) { W.u16(3); W.u16(1); W.u16(0x409); W.u16(id); W.u16(s.length * 2); W.u16(off); off += s.length * 2; }
    for (const [, s] of recs) for (const c of s) W.u16(c.charCodeAt(0));
  });
  const post = tableBytes(() => { W.u32(0x00030000); W.u32(0); W.i16(-PX); W.i16(PX); W.u32(0); W.u32(0); W.u32(0); W.u32(0); W.u32(0); });
  const tables = [['OS/2', os2], ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp], ['name', name], ['post', post]];
  const sum = (arr) => { let s = 0; for (let i = 0; i < arr.length; i += 4) s = (s + ((arr[i] << 24) | (arr[i + 1] << 16) | (arr[i + 2] << 8) | arr[i + 3])) >>> 0; return s; };
  const nt = tables.length, p2 = 2 ** Math.floor(Math.log2(nt));
  W.u32(0x00010000); W.u16(nt); W.u16(p2 * 16); W.u16(Math.log2(p2)); W.u16(nt * 16 - p2 * 16);
  let off = 12 + nt * 16;
  for (const [tag, t] of tables) {
    for (const c of tag) W.u8(c.charCodeAt(0));
    W.u32(sum(t)); W.u32(off); W.u32(t.len);
    off += t.length;
  }
  let headOff = 0;
  for (const [tag, t] of tables) { if (tag === 'head') headOff = bytes.length; for (const b of t) bytes.push(b); }
  const adj = (0xB1B0AFBA - sum(bytes)) >>> 0;
  bytes[headOff + 8] = adj >>> 24; bytes[headOff + 9] = (adj >>> 16) & 255; bytes[headOff + 10] = (adj >>> 8) & 255; bytes[headOff + 11] = adj & 255;
  return new Uint8Array(bytes).buffer;
}
async function loadPixelFont() {
  try {
    const face = new FontFace('MinePixel', buildPixelFont('MinePixel'));
    await face.load();
    document.fonts.add(face);
  } catch (e) { /* falls back to monospace */ }
}

// Audio — everything is synthesized, no music
const Sfx = (() => {
  let ctx = null, master = null, noiseBuf = null, echoIn = null, amb = null;
  let ambT = 0, dripT = 4, chirpT = 8;
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = settings.volume / 100;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // a little feedback echo used for cave drips
    echoIn = ctx.createGain();
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.21;
    const fb = ctx.createGain(); fb.gain.value = 0.42;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    echoIn.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(master);
    const bed = (freq) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(master); s.start();
      return { f, g };
    };
    amb = { wind: bed(380), cave: bed(130) };
  }
  function setVolume(v) { if (ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05); }
  function noise({ t = 0, dur = 0.1, type = 'lowpass', freq = 1000, freqEnd = 0, q = 0.7, gain = 0.3, rate = 1, attack = 0.004, echo = 0 }) {
    if (!ctx) return;
    const now = ctx.currentTime + t;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, now);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f); f.connect(g); g.connect(master);
    if (echo) { const e = ctx.createGain(); e.gain.value = echo; g.connect(e); e.connect(echoIn); }
    src.start(now, Math.random() * 1.5, dur + 0.05);
  }
  function tone({ t = 0, freq = 440, freqEnd = 0, dur = 0.1, type = 'sine', gain = 0.2, attack = 0.003, echo = 0 }) {
    if (!ctx) return;
    const now = ctx.currentTime + t;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(master);
    if (echo) { const e = ctx.createGain(); e.gain.value = echo; g.connect(e); e.connect(echoIn); }
    o.start(now); o.stop(now + dur + 0.05);
  }
  const r = (a, b) => a + Math.random() * (b - a);
  return {
    init, setVolume,
    break(type) {
      if (type === GRASS) {
        noise({ dur: 0.2, freq: 2600, freqEnd: 500, gain: 0.5, rate: r(0.8, 1.2) });
        noise({ t: 0.03, dur: 0.13, type: 'bandpass', freq: r(1000, 1500), q: 0.8, gain: 0.35 });
        noise({ t: 0.07, dur: 0.16, type: 'bandpass', freq: r(600, 900), q: 0.9, gain: 0.25 });
      } else {
        noise({ dur: 0.09, type: 'bandpass', freq: r(2600, 3400), q: 1.3, gain: 0.45 });
        noise({ dur: 0.25, freq: 1000, freqEnd: 180, gain: 0.5 });
        tone({ dur: 0.1, type: 'triangle', freq: r(220, 300), freqEnd: 110, gain: 0.25 });
        tone({ t: 0.02, dur: 0.06, type: 'triangle', freq: r(500, 620), freqEnd: 300, gain: 0.08 });
      }
    },
    place(type) {
      if (type === GRASS) {
        noise({ dur: 0.12, freq: 1400, freqEnd: 300, gain: 0.45, rate: r(0.9, 1.1) });
        noise({ t: 0.02, dur: 0.08, type: 'bandpass', freq: 900, q: 1, gain: 0.2 });
      } else {
        noise({ dur: 0.07, type: 'bandpass', freq: r(1600, 2000), q: 1.1, gain: 0.4 });
        tone({ dur: 0.09, type: 'triangle', freq: r(170, 210), freqEnd: 100, gain: 0.32 });
      }
    },
    step(type, vol = 1) {
      if (type === GRASS) noise({ dur: 0.1, type: 'bandpass', freq: r(800, 1300), q: 0.9, gain: 0.17 * vol, rate: r(0.8, 1.2) });
      else {
        noise({ dur: 0.05, type: 'highpass', freq: r(1800, 2600), gain: 0.1 * vol });
        noise({ dur: 0.07, freq: 500, gain: 0.13 * vol });
      }
    },
    jump() { noise({ dur: 0.12, freq: 500, freqEnd: 1300, gain: 0.05, attack: 0.04 }); },
    land(type, k) { noise({ dur: 0.2, freq: 420, freqEnd: 110, gain: 0.25 + 0.3 * k }); this.step(type, 1.3); },
    hover() { tone({ freq: 1320, dur: 0.04, gain: 0.035 }); },
    click() { tone({ freq: 440, freqEnd: 880, dur: 0.08, type: 'triangle', gain: 0.12 }); noise({ dur: 0.03, type: 'highpass', freq: 3000, gain: 0.07 }); },
    select() { tone({ freq: 990, dur: 0.05, gain: 0.06 }); tone({ t: 0.03, freq: 1480, dur: 0.04, gain: 0.03 }); },
    whoosh() { noise({ dur: 0.7, type: 'bandpass', freq: 300, freqEnd: 2600, q: 1.4, gain: 0.22, attack: 0.3 }); },
    denied() { tone({ freq: 150, freqEnd: 110, dur: 0.14, type: 'triangle', gain: 0.18 }); noise({ dur: 0.1, freq: 300, gain: 0.2 }); },
    save() { tone({ freq: 660, dur: 0.12, gain: 0.09 }); tone({ t: 0.09, freq: 990, dur: 0.22, gain: 0.09 }); },
    drip() { const f = r(1300, 2100); tone({ freq: f, freqEnd: f * 0.5, dur: 0.07, gain: 0.07, echo: 0.8 }); },
    chirp() { const n = 2 + (Math.random() * 3 | 0), f = r(2600, 3600); for (let i = 0; i < n; i++) tone({ t: i * 0.11, freq: f, freqEnd: f * 1.35, dur: 0.07, gain: 0.025 }); },
    ambience(dt, under, active) {
      if (!ctx || !amb) return;
      ambT += dt;
      const now = ctx.currentTime;
      const gust = 0.6 + 0.4 * Math.sin(ambT * 0.37) * Math.sin(ambT * 0.13 + 1);
      amb.wind.g.gain.setTargetAtTime(active ? 0.03 * (1 - under) * gust : 0.016 * gust, now, 0.4);
      amb.wind.f.frequency.setTargetAtTime(280 + 220 * (0.5 + 0.5 * Math.sin(ambT * 0.21)), now, 0.5);
      amb.cave.g.gain.setTargetAtTime(active ? 0.07 * under : 0, now, 0.6);
      if (!active) return;
      if ((dripT -= dt) <= 0) { dripT = r(2.5, 9); if (under > 0.5) this.drip(); }
      if ((chirpT -= dt) <= 0) { chirpT = r(7, 20); if (under < 0.2) this.chirp(); }
    },
  };
})();

// World data
const WX = 256, WY = 64, WZ = 256, CS = 16, CX = WX / CS, CZ = WZ / CS;
const AIR = 0, GRASS = 1, COBBLE = 2;
const BLOCK_NAMES = { [GRASS]: 'Grass Block', [COBBLE]: 'Cobblestone' };
const HOTBAR = [GRASS, COBBLE];
const SHADOW = 0.52;                 // brightness of blocks with no sky above (Cave Game style)
const AOC = [0.5, 0.68, 0.84, 1.0];  // ambient occlusion curve

const world = { blocks: new Uint8Array(WX * WY * WZ), top: new Int16Array(WX * WZ), seed: 1, type: 'hills', fresh: true };
const idx = (x, y, z) => (y * WZ + z) * WX + x;
function getBlock(x, y, z) {
  if (x < 0 || z < 0 || x >= WX || z >= WZ || y < 0 || y >= WY) return AIR;
  return world.blocks[idx(x, y, z)];
}
// collision: world walls are solid, below the world is solid, sky is open
function solidCollide(x, y, z) {
  if (x < 0 || z < 0 || x >= WX || z >= WZ || y < 0) return true;
  if (y >= WY) return false;
  return world.blocks[idx(x, y, z)] !== AIR;
}
// meshing: world edges render, nothing below y=0 is ever visible
function solidM(x, y, z) {
  if (x < 0 || z < 0 || x >= WX || z >= WZ || y >= WY) return false;
  if (y < 0) return true;
  return world.blocks[idx(x, y, z)] !== AIR;
}
function isLit(x, y, z) {
  if (x < 0 || z < 0 || x >= WX || z >= WZ || y >= WY) return 1;
  return y > world.top[z * WX + x] ? 1 : 0;
}
function updateTop(x, z) {
  let y = WY - 1;
  while (y >= 0 && !world.blocks[idx(x, y, z)]) y--;
  world.top[z * WX + x] = y;
}
function recomputeTops() { for (let z = 0; z < WZ; z++) for (let x = 0; x < WX; x++) updateTop(x, z); }

function* generate(type, seed) {
  const B = world.blocks; B.fill(0);
  const rnd = mulberry32(seed);
  const H = new Int16Array(WX * WZ);
  if (type === 'flat') {
    H.fill(43); // the original prototype's ground level
  } else {
    for (let z = 0; z < WZ; z++) for (let x = 0; x < WX; x++) {
      const n = fbm2(x / 56, z / 56, seed, 4);
      const m = fbm2(x / 170 + 50, z / 170, seed + 7, 2);
      const rd = 1 - Math.abs(noise2(x / 38, z / 38, seed + 3) * 2 - 1);
      const h = 32 + (n - 0.5) * 30 * (0.45 + m) + rd * rd * 7 * m;
      H[z * WX + x] = clamp(Math.round(h), 8, 56);
    }
  }
  yield 0.15;
  for (let z = 0; z < WZ; z++) for (let x = 0; x < WX; x++) {
    const h = H[z * WX + x];
    for (let y = 0; y <= h; y++) B[idx(x, y, z)] = y === h ? GRASS : COBBLE;
  }
  yield 0.35;
  if (type !== 'flat') {
    const carve = (cx, cy, cz, r) => {
      const r2 = r * r;
      for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.min(WY - 1, Math.ceil(cy + r)); y++)
        for (let z = Math.max(0, Math.floor(cz - r)); z <= Math.min(WZ - 1, Math.ceil(cz + r)); z++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(WX - 1, Math.ceil(cx + r)); x++) {
            const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) * 1.25, dz = z + 0.5 - cz;
            if (dx * dx + dy * dy + dz * dz < r2) B[idx(x, y, z)] = AIR;
          }
    };
    // winding worm tunnels — the "cave" in cave game
    for (let w = 0; w < 75; w++) {
      let px = rnd() * WX, py = 5 + rnd() * 30, pz = rnd() * WZ;
      let yaw = rnd() * Math.PI * 2, pitch = (rnd() - 0.5) * 0.5;
      const len = 60 + rnd() * 140, thick = 1.2 + rnd() * 1.2;
      for (let s = 0; s < len; s++) {
        px += Math.cos(yaw) * Math.cos(pitch); py += Math.sin(pitch); pz += Math.sin(yaw) * Math.cos(pitch);
        yaw += (rnd() - 0.5) * 0.45; pitch = pitch * 0.85 + (rnd() - 0.5) * 0.3;
        if (py < 3) pitch = Math.abs(pitch);
        carve(px, py, pz, thick + Math.sin(s / len * Math.PI) * 1.4 + rnd() * 0.3);
      }
      if (w % 15 === 14) yield 0.35 + 0.3 * (w / 75);
    }
    // a few big caverns
    for (let c = 0; c < 7; c++) {
      const cx = 20 + rnd() * (WX - 40), cz = 20 + rnd() * (WZ - 40), cy = 8 + rnd() * 10;
      for (let k = 0; k < 6; k++) carve(cx + (rnd() - 0.5) * 10, cy + (rnd() - 0.5) * 4, cz + (rnd() - 0.5) * 10, 3 + rnd() * 3);
    }
    // cobblestone boulders and outcrops
    for (let b = 0; b < 55; b++) {
      const bx = 4 + rnd() * (WX - 8), bz = 4 + rnd() * (WZ - 8);
      const h = H[Math.floor(bz) * WX + Math.floor(bx)], r = 1 + rnd() * 1.8;
      for (let y = h; y <= h + r * 1.6 && y < WY; y++)
        for (let z = Math.floor(bz - r); z <= Math.ceil(bz + r); z++)
          for (let x = Math.floor(bx - r); x <= Math.ceil(bx + r); x++) {
            const dx = x + 0.5 - bx, dy = (y + 0.5 - h) / 1.3, dz = z + 0.5 - bz;
            if (dx * dx + dy * dy + dz * dz < r * r * (0.8 + rnd() * 0.4) && x >= 0 && z >= 0 && x < WX && z < WZ && y > 0)
              B[idx(x, y, z)] = COBBLE;
          }
    }
  }
  for (let z = 0; z < WZ; z++) for (let x = 0; x < WX; x++) B[idx(x, 0, z)] = COBBLE; // unbreakable floor
  recomputeTops();
  world.seed = seed; world.type = type;
  yield 0.7;
}

// WebGL setup
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });

function fatal(html) {
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === 'scr-error');
  ui.errorMsg.innerHTML = html;
  ui.fade.style.opacity = 0.6;
}
if (!gl) { fatal('MinePlace needs <b>WebGL 2</b>, which this browser or device does not support.'); return; }

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.trim()); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

const WORLD_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in float aLayer; layout(location=3) in float aLight;
uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uCam;
out vec3 vUV; out float vLight; out float vDist;
void main(){ vec4 wp = uModel * vec4(aPos, 1.0); gl_Position = uVP * wp; vUV = vec3(aUV, aLayer); vLight = aLight; vDist = length(wp.xyz - uCam); }`;
const WORLD_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex; uniform vec3 uFog; uniform vec2 uFogRange; uniform float uLightMul; uniform vec4 uFlash;
in vec3 vUV; in float vLight; in float vDist; out vec4 o;
void main(){
  vec4 c = texture(uTex, vUV); if (c.a < 0.5) discard;
  vec3 col = c.rgb * vLight * uLightMul;
  col = mix(col, uFlash.rgb, uFlash.a);
  float f = clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  o = vec4(mix(col, uFog, f * f * (3.0 - 2.0 * f)), 1.0);
}`;
const COLOR_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uVP; void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`;
const COLOR_FS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;
const SKY_VS = `#version 300 es
out vec2 vN; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vN = p * 2.0 - 1.0; gl_Position = vec4(vN, 0.0, 1.0); }`;
const SKY_FS = `#version 300 es
precision highp float;
uniform vec3 uF, uR, uU, uSun, uZen, uHor; uniform vec2 uT; uniform sampler2D uSunTex; in vec2 vN; out vec4 o;
void main(){
  vec3 d = normalize(uF + vN.x * uT.x * uR + vN.y * uT.y * uU);
  float h = d.y;
  vec3 col = mix(uHor, uZen, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, uHor * 0.9, smoothstep(0.0, -0.35, h));
  // pixel-art sun: a simple 16x16 square texture on a grid locked to the sun's direction, with a 2-step square glow
  float sd = dot(d, uSun);
  if (sd > 0.0) {
    vec3 sr = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
    vec3 su = cross(sr, uSun);
    vec2 cell = floor(vec2(dot(d, sr), dot(d, su)) / sd / 0.012);  // one sun pixel per cell
    vec4 sun = vec4(0.0);
    if (all(greaterThanEqual(cell, vec2(-8.0))) && all(lessThan(cell, vec2(8.0))))
      sun = texelFetch(uSunTex, ivec2(int(cell.x) + 8, 7 - int(cell.y)), 0);
    if (sun.a > 0.5) {
      col = sun.rgb;
    } else {
      vec2 c = cell + 0.5;
      float g = max(abs(c.x), abs(c.y)) - 8.0;   // distance from the sun's edge, in sun pixels
      float lvl = g < 3.0 ? 0.28 : g < 6.0 ? 0.12 : 0.0;
      col = mix(col, vec3(1.0, 0.95, 0.7), lvl);
    }
  }
  o = vec4(col, 1.0);
}`;
const TITLE_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aCenter; layout(location=2) in vec2 aUV; layout(location=3) in float aLayer; layout(location=4) in float aShade;
uniform mat4 uVP; uniform float uTime, uIntro, uExplode, uOffY, uAspect, uHalfW; uniform vec2 uMouse;
out vec3 vUV; out float vShade;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float bounce(float t){
  const float n = 7.5625, d = 2.75;
  if (t < 1.0 / d) return n * t * t;
  if (t < 2.0 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
}
void main(){
  vec3 c = aCenter;
  float delay = (c.x + uHalfW) * 0.02 + h(c) * 0.3;
  float t = clamp((uIntro - delay) / 0.85, 0.0, 1.0);
  float drop = (1.0 - bounce(t)) * 28.0;
  float wave = sin(uTime * 1.8 + c.x * 0.3) * 0.22;
  vec4 cc = uVP * vec4(c, 1.0); vec2 ndc = cc.xy / cc.w; ndc.y += uOffY;
  float lift = smoothstep(0.26, 0.0, length((ndc - uMouse) * vec2(uAspect, 1.0))) * 1.3;
  vec3 dir = normalize(vec3(c.x * 0.08 + (h(c + 1.0) - 0.5) * 2.0, 0.8 + h(c + 2.0), 0.5 + h(c + 3.0)));
  float e = uExplode * uExplode;
  vec3 p = aPos + vec3(0.0, drop + wave + lift, 0.0) + dir * e * 60.0;
  gl_Position = uVP * vec4(p, 1.0); gl_Position.y += uOffY * gl_Position.w;
  vUV = vec3(aUV, aLayer); vShade = aShade * (1.0 + lift * 0.22);
}`;
const TITLE_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex; in vec3 vUV; in float vShade; out vec4 o;
void main(){ vec4 c = texture(uTex, vUV); o = vec4(c.rgb * vShade, 1.0); }`;

let progWorld, progColor, progSky, progTitle;
try {
  progWorld = program(WORLD_VS, WORLD_FS);
  progColor = program(COLOR_VS, COLOR_FS);
  progSky = program(SKY_VS, SKY_FS);
  progTitle = program(TITLE_VS, TITLE_FS);
} catch (e) { fatal('Shader error:<br><code>' + String(e.message).replace(/</g, '&lt;') + '</code>'); return; }

const FLOATS = 7, STRIDE = FLOATS * 4;
function worldAttribs() {
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 20);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 24);
}
function makeVAO(data, indices, usage = gl.STATIC_DRAW, attribs = worldAttribs) {
  const vao = gl.createVertexArray(), vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  attribs();
  let ibo = null;
  if (indices) { ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW); }
  gl.bindVertexArray(null);
  return { vao, vbo, ibo, count: indices ? indices.length : 0 };
}

// Block faces
// Faces in order: -X, +X, -Y, +Y, -Z, +Z. Each corner stores its in-plane neighbour directions for AO.
const FACES = [];
for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
  const n = [0, 0, 0]; n[axis] = sign;
  const ba = (axis + 1) % 3, ca = (axis + 2) % 3;
  let corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([qb, qc]) => {
    const p = [0, 0, 0]; p[axis] = sign > 0 ? 1 : 0; p[ba] = qb; p[ca] = qc;
    const ea = [0, 0, 0]; ea[ba] = qb ? 1 : -1;
    const eb = [0, 0, 0]; eb[ca] = qc ? 1 : -1;
    const uv = axis === 1 ? [p[0], p[2]] : [axis === 0 ? p[2] : p[0], 1 - p[1]];
    return { p, ea, eb, uv };
  });
  const a = corners[0].p, b = corners[1].p, c = corners[2].p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) corners = corners.reverse();
  const kind = axis === 1 ? (sign > 0 ? 'top' : 'bottom') : 'side';
  const shade = axis === 1 ? (sign > 0 ? 1.0 : 0.5) : axis === 0 ? 0.64 : 0.8;
  FACES.push({ n, c: corners, kind, shade });
}
const faceIndexOf = (n) => FACES.findIndex(f => f.n[0] === n[0] && f.n[1] === n[1] && f.n[2] === n[2]);
// texture layers: 0 grass, 1 cobblestone (every face of a block uses its own texture)
const LAYERS = [];
LAYERS[GRASS] = FACES.map(() => 0);
LAYERS[COBBLE] = FACES.map(() => 1);

// Chunk meshing
const chunks = [];
for (let cz = 0; cz < CZ; cz++) for (let cx = 0; cx < CX; cx++) chunks.push({ cx, cz, vao: null, vbo: null, ibo: null, count: 0, dirtyAt: -1 });
let MV = new Float32Array(FLOATS * 4 * 30000), MI = new Uint32Array(6 * 30000);

function meshChunk(ch) {
  const B = world.blocks, T = world.top;
  const x0 = ch.cx * CS, z0 = ch.cz * CS;
  let maxY = 0;
  for (let z = z0; z < z0 + CS; z++) for (let x = x0; x < x0 + CS; x++) maxY = Math.max(maxY, T[z * WX + x]);
  let vn = 0, ii = 0, nv = 0;
  const ao = [0, 0, 0, 0];
  for (let y = 0; y <= maxY; y++) for (let z = z0; z < z0 + CS; z++) for (let x = x0; x < x0 + CS; x++) {
    const b = B[idx(x, y, z)];
    if (!b) continue;
    const L = LAYERS[b];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const nx = x + F.n[0], ny = y + F.n[1], nz = z + F.n[2];
      if (solidM(nx, ny, nz)) continue;
      if (vn + FLOATS * 4 > MV.length) { const t = new Float32Array(MV.length * 2); t.set(MV); MV = t; const u = new Uint32Array(MI.length * 2); u.set(MI); MI = u; }
      const layer = L[f];
      for (let i = 0; i < 4; i++) {
        const C = F.c[i], ea = C.ea, eb = C.eb;
        const ax = nx + ea[0], ay = ny + ea[1], az = nz + ea[2];
        const bx = nx + eb[0], by = ny + eb[1], bz = nz + eb[2];
        const cx = ax + eb[0], cy = ay + eb[1], cz = az + eb[2];
        const s1 = solidM(ax, ay, az), s2 = solidM(bx, by, bz), s3 = solidM(cx, cy, cz);
        const a = (s1 && s2) ? 0 : 3 - (s1 + s2 + s3);
        let lit = isLit(nx, ny, nz), cnt = 1;
        if (!s1) { lit += isLit(ax, ay, az); cnt++; }
        if (!s2) { lit += isLit(bx, by, bz); cnt++; }
        if (!s3 && !(s1 && s2)) { lit += isLit(cx, cy, cz); cnt++; }
        ao[i] = a;
        MV[vn++] = x + C.p[0]; MV[vn++] = y + C.p[1]; MV[vn++] = z + C.p[2];
        MV[vn++] = C.uv[0]; MV[vn++] = C.uv[1]; MV[vn++] = layer;
        MV[vn++] = F.shade * (SHADOW + (1 - SHADOW) * lit / cnt) * AOC[a];
      }
      if (ao[0] + ao[2] < ao[1] + ao[3]) { MI[ii++] = nv + 1; MI[ii++] = nv + 2; MI[ii++] = nv + 3; MI[ii++] = nv + 1; MI[ii++] = nv + 3; MI[ii++] = nv; }
      else { MI[ii++] = nv; MI[ii++] = nv + 1; MI[ii++] = nv + 2; MI[ii++] = nv; MI[ii++] = nv + 2; MI[ii++] = nv + 3; }
      nv += 4;
    }
  }
  if (!ch.vao) {
    ch.vao = gl.createVertexArray(); ch.vbo = gl.createBuffer(); ch.ibo = gl.createBuffer();
    gl.bindVertexArray(ch.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ch.vbo); worldAttribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.ibo);
    gl.bindVertexArray(null);
  }
  gl.bindVertexArray(ch.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ch.vbo); gl.bufferData(gl.ARRAY_BUFFER, MV.subarray(0, vn), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, MI.subarray(0, ii), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  ch.count = ii; ch.dirtyAt = -1;
}
async function meshAll(onProgress) {
  for (let i = 0; i < chunks.length; i++) {
    meshChunk(chunks[i]);
    if (i % 12 === 11) { onProgress && onProgress(i / chunks.length); await nextFrame(); }
  }
}
function markDirty(x, z, at) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, zz = z + dz;
    if (xx < 0 || zz < 0 || xx >= WX || zz >= WZ) continue;
    const ch = chunks[(zz >> 4) * CX + (xx >> 4)];
    ch.dirtyAt = ch.dirtyAt < 0 ? at : Math.min(ch.dirtyAt, at);
  }
}
function setBlock(x, y, z, b, delay = 0) {
  world.blocks[idx(x, y, z)] = b;
  const t = world.top[z * WX + x];
  if (b && y > t) world.top[z * WX + x] = y;
  else if (!b && y === t) updateTop(x, z);
  markDirty(x, z, time + delay);
}

// Textures (only the two supplied PNGs)
function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('missing ' + src)); im.src = src; });
}
function pixels16(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data; // throws on file:// in some browsers
  const out = new Uint8ClampedArray(16 * 16 * 4), sx = img.width / 16, sy = img.height / 16;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const px = Math.min(img.width - 1, Math.floor((x + 0.5) * sx)), py = Math.min(img.height - 1, Math.floor((y + 0.5) * sy));
    const s = (py * img.width + px) * 4, o = (y * 16 + x) * 4;
    out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = 255;
  }
  return out;
}
function scaledTexture(px, f) {
  const c = document.createElement('canvas'); c.width = c.height = 16 * f;
  const g = c.getContext('2d');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const o = (y * 16 + x) * 4;
    g.fillStyle = `rgb(${px[o]},${px[o + 1]},${px[o + 2]})`;
    g.fillRect(x * f, y * f, f, f);
  }
  return c.toDataURL();
}
function texCanvas(px) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), 16, 16), 0, 0);
  return c;
}
function isoIcon(top, side) {
  const S = 96, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  const w = S * 0.86, sh = w * 0.56, cx = S / 2, y0 = (S - (w / 2 + sh)) / 2;
  const faces = [
    [top, [w / 32, w / 64, -w / 32, w / 64, cx, y0], 0],
    [side, [w / 32, w / 64, 0, sh / 16, cx - w / 2, y0 + w / 4], 0.25],
    [side, [w / 32, -w / 64, 0, sh / 16, cx, y0 + w / 2], 0.45],
  ];
  for (const [img, m, dark] of faces) {
    g.setTransform(...m);
    g.drawImage(img, 0, 0);
    if (dark) { g.fillStyle = `rgba(0,0,0,${dark})`; g.fillRect(0, 0, 16, 16); }
  }
  return c.toDataURL();
}

let texArray = null, sunTex = null;
// A simple 16x16 sun: flat yellow with a one-pixel rim and a faint speckle borrowed from the grass texture.
function makeSunPixels(grass) {
  const out = new Uint8Array(16 * 16 * 4);
  let lo = 1e9, hi = -1e9;
  const lum = i => grass[i * 4] * 0.3 + grass[i * 4 + 1] * 0.59 + grass[i * 4 + 2] * 0.11;
  for (let i = 0; i < 256; i++) { lo = Math.min(lo, lum(i)); hi = Math.max(hi, lum(i)); }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const o = (y * 16 + x) * 4;
    const rim = x === 0 || y === 0 || x === 15 || y === 15;
    const t = (lum(y * 16 + x) - lo) / Math.max(1, hi - lo) - 0.5;   // slight texture speckle
    const [r, g, b] = rim ? [255, 196, 60] : [255, 238, 120];
    const k = 1 + t * 0.06;
    out[o] = Math.min(255, r * k); out[o + 1] = Math.min(255, g * k); out[o + 2] = Math.min(255, b * k); out[o + 3] = 255;
  }
  return out;
}
const icons = {};
async function loadTextures() {
  const [gImg, cImg] = await Promise.all([loadImage('img/grasstexture.png'), loadImage('img/cobblestonetexture.png')]);
  const grass = pixels16(gImg), cobble = pixels16(cImg);
  const layers = [grass, cobble];
  const data = new Uint8Array(16 * 16 * 4 * layers.length);
  layers.forEach((l, i) => data.set(l, i * 1024));
  texArray = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 16, 16, layers.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  sunTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, sunTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeSunPixels(grass));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.activeTexture(gl.TEXTURE0);
  const cg = texCanvas(grass), cc = texCanvas(cobble);
  icons[GRASS] = isoIcon(cg, cg);
  icons[COBBLE] = isoIcon(cc, cc);
  // Menus get the textures pre-enlarged with hard pixel edges at the exact device size they are shown at,
  // so the browser never has to smooth them (some browsers ignore image-rendering on CSS backgrounds).
  const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
  const css = document.documentElement.style;
  css.setProperty('--tex-grass', `url(${scaledTexture(grass, 3 * dpr)})`);
  css.setProperty('--tex-cobble', `url(${scaledTexture(cobble, 3 * dpr)})`);
  css.setProperty('--tex-cobble-big', `url(${scaledTexture(cobble, 6 * dpr)})`);
}

// Static meshes: single cubes (hand / pop animations) and the voxel title
function cubeMesh(type) {
  const v = [], ix = [];
  FACES.forEach((F, f) => {
    const base = v.length / FLOATS;
    for (const C of F.c) v.push(C.p[0] - 0.5, C.p[1] - 0.5, C.p[2] - 0.5, C.uv[0], C.uv[1], LAYERS[type][f], F.shade);
    ix.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return makeVAO(new Float32Array(v), new Uint32Array(ix));
}
let cubeVAOs = {};

const GLYPHS = {
  M: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
  i: ['1', '.', '1', '1', '1', '1', '1'],
  n: ['....', '....', '111.', '1..1', '1..1', '1..1', '1..1'],
  e: ['....', '....', '.11.', '1..1', '1111', '1...', '.111'],
  P: ['111.', '1..1', '1..1', '111.', '1...', '1...', '1...'],
  l: ['1.', '1.', '1.', '1.', '1.', '1.', '.1'],
  a: ['....', '....', '111.', '...1', '.111', '1..1', '.111'],
  c: ['....', '....', '.111', '1...', '1...', '1...', '.111'],
};
let titleMesh = null, titleHalfW = 20;
function buildTitle(word) {
  const cells = new Set(), list = [];
  let gx = 0;
  for (const ch of word) {
    const g = GLYPHS[ch];
    for (let r = 0; r < 7; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '1') {
      for (let d = 0; d < 2; d++) { const k = `${gx + c},${6 - r},${d}`; cells.add(k); list.push([gx + c, 6 - r, d]); }
    }
    gx += g[0].length + 1;
  }
  const W = gx - 1; titleHalfW = W / 2;
  const has = (x, y, z) => cells.has(`${x},${y},${z}`);
  const v = [], ix = [];
  const SH = { top: 1.0, bottom: 0.55 };
  for (const [x, y, z] of list) {
    const open = !has(x, y + 1, z);
    const cx = x - W / 2 + 0.5, cy = y - 3, cz = z - 0.5;
    // Every face is kept, even ones touching a neighbour: the blocks animate independently (drop-in, wave,
    // mouse lift), and culled inner faces would open see-through cracks to the sky between them.
    // Cubes are also grown a hair so adjacent blocks overlap and never leave sub-pixel seams.
    const G = 1.012;
    FACES.forEach((F) => {
      const layer = open ? 0 : 1; // letters: grass blocks on top, cobblestone underneath
      const shade = SH[F.kind] || (F.n[2] > 0 ? 0.93 : F.n[2] < 0 ? 0.6 : 0.74);
      const base = v.length / 10;
      for (const C of F.c) v.push(cx + (C.p[0] - 0.5) * G, cy + (C.p[1] - 0.5) * G, cz + (C.p[2] - 0.5) * G, cx, cy, cz, C.uv[0], C.uv[1], layer, shade);
      ix.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  titleMesh = makeVAO(new Float32Array(v), new Uint32Array(ix), gl.STATIC_DRAW, () => {
    const S = 40;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, S, 36);
  });
}

// dynamic buffers
const MAX_PARTICLES = 2500;
const partData = new Float32Array(MAX_PARTICLES * 6 * FLOATS);
let partVAO = null;
const lineData = new Float32Array(64 * 3);
let lineVAO = null, skyVAO = null;
function initDynamic() {
  partVAO = makeVAO(partData.byteLength, null, gl.DYNAMIC_DRAW);
  lineVAO = makeVAO(lineData.byteLength, null, gl.DYNAMIC_DRAW, () => { gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); });
  skyVAO = gl.createVertexArray();
  cubeVAOs = { [GRASS]: cubeMesh(GRASS), [COBBLE]: cubeMesh(COBBLE) };
  buildTitle('MinePlace');
}

// Game state
let state = 'boot';           // boot | loading | menu | transition | playing | paused
let screen = null, controlsReturn = 'scr-title';
let time = 0, hasSave = false, locked = false;
const player = {
  pos: [128.5, 50, 128.5], vel: [0, 0, 0], yaw: 0, pitch: -0.15, onGround: false,
  sprinting: false, bobPhase: 0, bobAmt: 0, dipT: 1, dipAmt: 0,
  fovKick: 0, fovPulse: 0, shake: 0, light: 1, under: 0,
};
const PW = 0.3, PH = 1.8;
const down = {}, lastAct = {};   // action -> held?
let slot = 0, target = null, swingT = 1, equip = 1, sway = [0, 0];
const particles = [], pops = [];
let camBlendLin = 0, titleIntro = 0, titleHide = 0, titleExplode = -1;
let mouseNdc = [9, 9], autosaveT = 0, itemNameT = null;

function showScreen(id) {
  screen = id;
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === id);
}
function toast(msg) {
  ui.toast.textContent = msg; ui.toast.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => ui.toast.classList.remove('show'), 1800);
}
function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function flashScreen() { restartAnim(ui.flash, 'go'); }

// ---------- saving (IndexedDB holds the raw 4 MB block array) ----------
const DB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mineplace', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('worlds');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async put(key, val) {
    const db = await DB.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('worlds', 'readwrite'); tx.objectStore('worlds').put(val, key);
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); };
    });
  },
  async del(key) {
    const db = await DB.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('worlds', 'readwrite'); tx.objectStore('worlds').delete(key);
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); };
    });
  },
  async get(key) {
    const db = await DB.open();
    return new Promise((res, rej) => {
      const r = db.transaction('worlds', 'readonly').objectStore('worlds').get(key);
      r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); rej(r.error); };
    });
  },
};
let saving = false;
async function saveWorld(silent) {
  if (saving) return;
  saving = true;
  try {
    await DB.put('main', {
      v: 1, blocks: world.blocks, seed: world.seed, type: world.type, slot,
      player: { pos: player.pos.slice(), yaw: player.yaw, pitch: player.pitch }, savedAt: Date.now(),
    });
    hasSave = true; world.fresh = false;
    if (!silent) { toast('World saved'); Sfx.save(); }
  } catch (e) {
    if (!silent) toast('Could not save the world');
  }
  saving = false;
  updateMenuButtons();
}
function updateMenuButtons() {
  ui.btnContinue.style.display = hasSave ? '' : 'none';
  ui.btnReset.style.display = hasSave ? '' : 'none';
  disarmReset();
  ui.playNote.textContent = hasSave ? 'A new world replaces your saved one.' : '';
}

// ---------- loading / world building ----------
function setLoading(msg, p) { ui.loadMsg.textContent = msg; ui.loadBar.style.width = (p * 100).toFixed(1) + '%'; }
async function buildWorld(type, seed) {
  for (const p of generate(type, seed)) {
    setLoading(type === 'flat' ? 'Laying flat ground...' : p < 0.3 ? 'Shaping hills...' : p < 0.68 ? 'Digging caves...' : 'Settling stones...', p * 0.5);
    await nextFrame();
  }
  await meshAll(p => setLoading('Building chunks...', 0.5 + p * 0.5));
  setLoading('Done!', 1);
  world.fresh = true;
}
function spawnPlayer(random) {
  const rnd = Math.random;
  let x = 128, z = 128;
  for (let tries = 0; tries < 40; tries++) {
    if (random || tries > 0) { x = 24 + Math.floor(rnd() * (WX - 48)); z = 24 + Math.floor(rnd() * (WZ - 48)); }
    const t = world.top[z * WX + x];
    if (t > 0 && t < WY - 3) break;
  }
  const t = world.top[z * WX + x];
  player.pos = [x + 0.5, t + 1.001, z + 0.5];
  player.vel = [0, 0, 0];
  player.yaw = rnd() * Math.PI * 2; player.pitch = -0.1;
  player.onGround = false;
}

// ---------- reset progress (two clicks: arm, then confirm) ----------
let resetArmed = false, resetTimer = null;
function disarmReset() {
  resetArmed = false; clearTimeout(resetTimer);
  ui.btnReset.classList.remove('armed'); ui.btnReset.textContent = 'Reset Progress';
}
async function resetProgress() {
  if (state !== 'menu') return;
  if (!resetArmed) {
    resetArmed = true;
    ui.btnReset.classList.add('armed');
    ui.btnReset.textContent = 'Click again to delete';
    ui.playNote.textContent = 'This deletes your saved world forever!';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { disarmReset(); updateMenuButtons(); }, 4000);
    return;
  }
  disarmReset();
  Sfx.break(COBBLE);
  try { await DB.del('main'); } catch (e) { /* nothing saved */ }
  hasSave = false;
  state = 'loading'; showScreen('scr-loading');
  await buildWorld('hills', (Math.random() * 2147483647) | 0);
  particles.length = 0; pops.length = 0;
  spawnPlayer(false);
  selectSlot(0, true);
  state = 'menu';
  showScreen('scr-play');
  updateMenuButtons();
  ui.playNote.textContent = 'Progress reset. Start a new world!';
}

// ---------- menus & flow ----------
async function startGame(mode) {
  if (state !== 'menu') return;
  requestLock();
  if (mode === 'hills' || mode === 'flat') {
    if (!(world.fresh && world.type === mode)) {
      state = 'loading'; showScreen('scr-loading');
      await buildWorld(mode, (Math.random() * 2147483647) | 0);
      particles.length = 0; pops.length = 0;
    }
    spawnPlayer(false);
    selectSlot(0, true);
    saveWorld(true);
  }
  enterPlay();
}
function enterPlay() {
  state = 'transition';
  showScreen(null);
  if (titleHide < 0.5) titleExplode = 0;
  equip = 1;
  Sfx.whoosh();
  document.body.classList.add('playing');
  ui.hud.classList.add('show');
}
function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  showScreen('scr-pause');
  ui.pauseNote.textContent = '';
  releaseAll();
  saveWorld(true);
}
function resume() {
  ui.pauseNote.textContent = '';
  requestLock(() => { ui.pauseNote.textContent = 'Click "Back to Game" again to capture the mouse.'; });
}
async function quitToTitle() {
  await saveWorld(false);
  state = 'menu';
  showScreen('scr-title');
  titleIntro = 0; titleExplode = -1; titleHide = 0;
  ui.hud.classList.remove('show');
  ui.click.classList.remove('show');
  document.body.classList.remove('playing');
  if (document.pointerLockElement) document.exitPointerLock();
}
function requestLock(onFail) {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => onFail && onFail());
  } catch (e) { onFail && onFail(); }
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) {
    ui.click.classList.remove('show');
    if (state === 'paused') { state = 'playing'; showScreen(null); }
  } else if (state === 'playing') pause();
});
document.addEventListener('pointerlockerror', () => {
  if (state === 'paused') ui.pauseNote.textContent = 'Click "Back to Game" again to capture the mouse.';
});

function onAction(act) {
  Sfx.init(); Sfx.click();
  switch (act) {
    case 'play': showScreen('scr-play'); updateMenuButtons(); break;
    case 'controls': controlsReturn = screen; showScreen('scr-controls'); break;
    case 'controls-back': listening = null; renderBinds(); showScreen(controlsReturn || 'scr-title'); break;
    case 'reset-settings': resetSettings(); break;
    case 'back': showScreen('scr-title'); break;
    case 'continue': startGame('continue'); break;
    case 'new-hills': startGame('hills'); break;
    case 'new-flat': startGame('flat'); break;
    case 'reset-progress': resetProgress(); break;
    case 'resume': resume(); break;
    case 'quit': quitToTitle(); break;
  }
}
for (const b of $$('button[data-act]')) {
  b.addEventListener('click', () => onAction(b.dataset.act));
  b.addEventListener('mouseenter', () => Sfx.hover());
}
ui.click.addEventListener('click', () => { Sfx.init(); requestLock(); });

// options
const optRefresh = [];
function bindRange(id, key, fmt, onChange) {
  const el = $('#' + id), out = $('#' + id + 'V');
  const refresh = () => { el.value = settings[key]; out.textContent = fmt(settings[key]); };
  refresh(); optRefresh.push(refresh);
  el.addEventListener('input', () => { settings[key] = +el.value; out.textContent = fmt(settings[key]); saveSettings(); onChange && onChange(); });
}
bindRange('optSens', 'sens', v => Math.round(v * 100) + '%');
bindRange('optFov', 'fov', v => v + '°');
bindRange('optDist', 'renderDist', v => v + ' blocks');
bindRange('optVol', 'volume', v => v + '%', () => Sfx.setVolume(settings.volume / 100));
for (const [id, key, label] of [['optBob', 'bob', 'View Bobbing'], ['optInv', 'invertY', 'Invert Mouse']]) {
  const el = $('#' + id);
  const refresh = () => { el.textContent = label + ': ' + (settings[key] ? 'ON' : 'OFF'); };
  refresh(); optRefresh.push(refresh);
  el.addEventListener('click', () => { Sfx.click(); settings[key] = !settings[key]; saveSettings(); refresh(); });
  el.addEventListener('mouseenter', () => Sfx.hover());
}
function resetSettings() {
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k in d) settings[k] = d[k];
  listening = null;
  saveSettings();
  optRefresh.forEach(f => f());
  renderBinds();
  Sfx.setVolume(settings.volume / 100);
}

// key binding
let listening = null, swallowClick = false;
function keyName(code) {
  if (code.startsWith('Mouse')) return ['Left Click', 'Middle Click', 'Right Click', 'Mouse 4', 'Mouse 5'][+code.slice(5)] || code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names = {
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Cmd', MetaRight: 'Right Cmd', Space: 'Space',
    ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', CapsLock: 'Caps Lock',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  return names[code] || code.replace(/^Numpad/, 'Num ');
}
function renderBinds() {
  ui.binds.innerHTML = '';
  for (const [a, label] of ACTIONS) {
    const row = document.createElement('div'); row.className = 'bind';
    const span = document.createElement('span'); span.textContent = label;
    const btn = document.createElement('button');
    btn.textContent = listening === a ? '> Press a key <' : keyName(settings.binds[a]);
    btn.classList.toggle('listening', listening === a);
    btn.addEventListener('click', () => { Sfx.click(); listening = a; renderBinds(); });
    btn.addEventListener('mouseenter', () => Sfx.hover());
    row.append(span, btn);
    ui.binds.appendChild(row);
  }
}
function finishRebind(code) {
  const a = listening;
  listening = null;
  if (code && code !== 'Escape') {
    const other = ACTIONS.find(([b]) => b !== a && settings.binds[b] === code);
    if (other) settings.binds[other[0]] = settings.binds[a]; // swap instead of leaving a duplicate
    settings.binds[a] = code;
    saveSettings();
    Sfx.select();
  } else Sfx.click();
  renderBinds();
}
renderBinds();

// hotbar
function buildHotbar() {
  ui.hotbar.innerHTML = '';
  HOTBAR.forEach((b, i) => {
    const s = document.createElement('div'); s.className = 'slot';
    s.innerHTML = `<span>${i + 1}</span><img class="px" alt="${BLOCK_NAMES[b]}" src="${icons[b]}">`;
    ui.hotbar.appendChild(s);
  });
  selectSlot(slot, true);
}
function selectSlot(i, silent) {
  slot = (i % HOTBAR.length + HOTBAR.length) % HOTBAR.length;
  const els = ui.hotbar.children;
  for (let k = 0; k < els.length; k++) els[k].classList.toggle('sel', k === slot);
  if (silent) return;
  if (els[slot]) restartAnim(els[slot], 'bump');
  ui.itemName.textContent = BLOCK_NAMES[HOTBAR[slot]];
  ui.itemName.classList.add('show');
  clearTimeout(itemNameT); itemNameT = setTimeout(() => ui.itemName.classList.remove('show'), 1400);
  equip = 1;
  Sfx.select();
}

// ---------- input ----------
function actionFor(code) { for (const [a] of ACTIONS) if (settings.binds[a] === code) return a; return null; }
function releaseAll() { for (const k in down) down[k] = false; }
function inputDown(code) {
  const a = actionFor(code);
  if (!a) return false;
  if (down[a]) return true;
  down[a] = true;
  if (a === 'break') { lastAct.break = time; doBreak(); }
  else if (a === 'place') { lastAct.place = time; doPlace(); }
  else if (a === 'reset') resetPosition();
  return true;
}
function inputUp(code) { const a = actionFor(code); if (a) down[a] = false; }
function resetPosition() { spawnPlayer(true); player.fovPulse = 1; flashScreen(); Sfx.whoosh(); toast('Position reset'); }

addEventListener('keydown', e => {
  Sfx.init();
  if (listening) { e.preventDefault(); e.stopPropagation(); finishRebind(e.code); return; }
  if (state === 'playing' && locked) {
    if (e.repeat) { if (actionFor(e.code)) e.preventDefault(); return; }
    if (inputDown(e.code)) e.preventDefault();
    else if (e.code === 'Digit1') selectSlot(0);
    else if (e.code === 'Digit2') selectSlot(1);
    else if (e.code === 'Space' || e.code === 'Tab') e.preventDefault(); // never scroll the page
    return;
  }
  if (e.code === 'Escape') {
    if (screen === 'scr-controls') onAction('controls-back');
    else if (state === 'menu' && screen === 'scr-play') onAction('back');
  }
}, true);
addEventListener('keyup', e => inputUp(e.code));
addEventListener('blur', releaseAll);
// while rebinding, the next mouse button becomes the binding (and its click is swallowed)
addEventListener('mousedown', e => {
  if (!listening) return;
  e.preventDefault(); e.stopPropagation();
  swallowClick = true;
  finishRebind('Mouse' + e.button);
}, true);
addEventListener('click', e => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
canvas.addEventListener('mousedown', e => {
  Sfx.init();
  if (state !== 'playing') return;
  if (!locked) { requestLock(); return; }
  if (inputDown('Mouse' + e.button)) e.preventDefault();
});
addEventListener('mouseup', e => inputUp('Mouse' + e.button));
addEventListener('mousemove', e => {
  mouseNdc = [e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2];
  if (!locked || state !== 'playing') return;
  const mx = e.movementX, my = e.movementY;
  if (Math.abs(mx) > 400 || Math.abs(my) > 400) return; // browser glitch spikes
  const s = 0.0022 * settings.sens;
  player.yaw -= mx * s;
  player.pitch = clamp(player.pitch - my * s * (settings.invertY ? -1 : 1), -1.55, 1.55);
  sway[0] += mx * 0.0006; sway[1] += my * 0.0006;
});
addEventListener('wheel', e => { if (state === 'playing' && locked && e.deltaY) selectSlot(slot + Math.sign(e.deltaY)); }, { passive: true });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointerdown', () => Sfx.init(), true);
document.addEventListener('visibilitychange', () => { if (document.hidden && (state === 'playing' || state === 'paused')) saveWorld(true); });
addEventListener('beforeunload', () => { if (state === 'playing' || state === 'paused') saveWorld(true); });

// ---------- interaction ----------
function eyePos() { return [player.pos[0], player.pos[1] + 1.62, player.pos[2]]; }
function lookDir() {
  const cp = Math.cos(player.pitch);
  return [-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp];
}
function raycast(o, d, maxD) {
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const sx = Math.sign(d[0]), sy = Math.sign(d[1]), sz = Math.sign(d[2]);
  const tdx = d[0] ? Math.abs(1 / d[0]) : Infinity, tdy = d[1] ? Math.abs(1 / d[1]) : Infinity, tdz = d[2] ? Math.abs(1 / d[2]) : Infinity;
  let tx = d[0] ? (sx > 0 ? x + 1 - o[0] : o[0] - x) * tdx : Infinity;
  let ty = d[1] ? (sy > 0 ? y + 1 - o[1] : o[1] - y) * tdy : Infinity;
  let tz = d[2] ? (sz > 0 ? z + 1 - o[2] : o[2] - z) * tdz : Infinity;
  let n = [0, 0, 0], t = 0;
  for (let i = 0; i < 64; i++) {
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; n = [-sx, 0, 0]; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; n = [0, -sy, 0]; }
    else { z += sz; t = tz; tz += tdz; n = [0, 0, -sz]; }
    if (t > maxD) return null;
    if (getBlock(x, y, z)) return { x, y, z, n, t };
  }
  return null;
}
function swing() { swingT = 0; restartAnim(ui.crosshair, 'pulse'); }
function doBreak() {
  swing();
  if (!target) return;
  const { x, y, z } = target, type = getBlock(x, y, z);
  if (y === 0) { Sfx.denied(); player.shake = Math.max(player.shake, 0.05); return; }
  setBlock(x, y, z, AIR);
  spawnBreakParticles(x, y, z, type);
  pops.push({ x, y, z, type, t: 0, dur: 0.13, kind: 'break' });
  Sfx.break(type);
  player.shake = Math.max(player.shake, 0.09);
}
function doPlace() {
  if (!target) return;
  const x = target.x + target.n[0], y = target.y + target.n[1], z = target.z + target.n[2];
  if (x < 0 || z < 0 || x >= WX || z >= WZ || y < 0 || y >= WY || getBlock(x, y, z)) return;
  const p = player.pos;
  if (x < p[0] + PW && x + 1 > p[0] - PW && y < p[1] + PH && y + 1 > p[1] && z < p[2] + PW && z + 1 > p[2] - PW) return;
  const type = HOTBAR[slot];
  const dur = 0.16;
  setBlock(x, y, z, type, dur - 0.04); // remesh just before the pop animation ends (no flicker gap)
  pops.push({ x, y, z, type, t: 0, dur, kind: 'place' });
  spawnPuff(x, y, z, type);
  Sfx.place(type);
  swing();
}

// ---------- particles ----------
function randomLayer(type) {
  return type === GRASS ? 0 : 1;
}
function addParticle(p) { if (particles.length < MAX_PARTICLES) particles.push(p); }
function spawnBreakParticles(bx, by, bz, type) {
  // 4x4x4 = 64 particles per broken block
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
    const px = bx + (i + 0.5) / 4, py = by + (j + 0.5) / 4, pz = bz + (k + 0.5) / 4;
    const life = 0.5 + Math.random() * 0.9;
    addParticle({
      x: px, y: py, z: pz,
      vx: (px - bx - 0.5) * 5 + (Math.random() - 0.5) * 1.6,
      vy: (py - by - 0.5) * 5 + 1.5 + Math.random() * 2.5,
      vz: (pz - bz - 0.5) * 5 + (Math.random() - 0.5) * 1.6,
      life, max: life, size: 0.05 + Math.random() * 0.06, layer: randomLayer(type),
      u: Math.floor(Math.random() * 13) / 16, v: Math.floor(Math.random() * 13) / 16,
    });
  }
}
function spawnPuff(bx, by, bz, type) {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, life = 0.3 + Math.random() * 0.3;
    addParticle({
      x: bx + 0.5 + Math.cos(a) * 0.55, y: by + 0.05, z: bz + 0.5 + Math.sin(a) * 0.55,
      vx: Math.cos(a) * 2.2, vy: 1 + Math.random() * 1.5, vz: Math.sin(a) * 2.2,
      life, max: life, size: 0.035 + Math.random() * 0.03, layer: randomLayer(type),
      u: Math.floor(Math.random() * 13) / 16, v: Math.floor(Math.random() * 13) / 16,
    });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
    p.vy -= 22 * dt;
    const drag = Math.exp(-1.2 * dt); p.vx *= drag; p.vz *= drag;
    let nx = p.x + p.vx * dt;
    if (solidCollide(Math.floor(nx), Math.floor(p.y), Math.floor(p.z))) p.vx *= -0.3; else p.x = nx;
    let ny = p.y + p.vy * dt;
    if (solidCollide(Math.floor(p.x), Math.floor(ny), Math.floor(p.z))) {
      if (p.vy < 0) { p.vy *= -0.3; p.vx *= 0.55; p.vz *= 0.55; if (Math.abs(p.vy) < 0.6) p.vy = 0; } else p.vy = 0;
    } else p.y = ny;
    let nz = p.z + p.vz * dt;
    if (solidCollide(Math.floor(p.x), Math.floor(p.y), Math.floor(nz))) p.vz *= -0.3; else p.z = nz;
  }
}

// ---------- player physics ----------
function moveAxis(a, d) {
  if (!d) return;
  const p = player.pos;
  p[a] += d;
  const E = 1e-4;
  const minX = p[0] - PW, maxX = p[0] + PW - E, minY = p[1], maxY = p[1] + PH - E, minZ = p[2] - PW, maxZ = p[2] + PW - E;
  let hit = false, best = d > 0 ? Infinity : -Infinity;
  for (let y = Math.floor(minY); y <= Math.floor(maxY); y++)
    for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++)
      for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
        if (!solidCollide(x, y, z)) continue;
        hit = true;
        const c = a === 0 ? x : a === 1 ? y : z;
        if (d > 0) best = Math.min(best, c); else best = Math.max(best, c + 1);
      }
  if (!hit) return;
  if (a === 1) {
    if (d > 0) p[1] = best - PH - E; else { p[1] = best + E; player.onGround = true; }
  } else {
    p[a] = d > 0 ? best - PW - E : best + PW + E;
  }
  player.vel[a] = 0;
}
function blockBelow() {
  const p = player.pos;
  for (const [ox, oz] of [[0, 0], [PW, PW], [-PW, PW], [PW, -PW], [-PW, -PW]]) {
    const b = getBlock(Math.floor(p[0] + ox), Math.floor(p[1] - 0.2), Math.floor(p[2] + oz));
    if (b) return b;
  }
  return COBBLE;
}
function updatePlayer(dt) {
  const pl = player, v = pl.vel;
  const fwd = (down.forward ? 1 : 0) - (down.back ? 1 : 0), str = (down.right ? 1 : 0) - (down.left ? 1 : 0);
  pl.sprinting = !!down.sprint && fwd > 0;
  const sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw);
  let wx = -sy * fwd + cy * str, wz = -cy * fwd - sy * str;
  const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
  const speed = pl.sprinting ? 5.9 : 4.3;
  const ka = Math.min(1, (pl.onGround ? 16 : 3.5) * dt);
  v[0] += (wx * speed - v[0]) * ka;
  v[2] += (wz * speed - v[2]) * ka;
  v[1] = Math.max(-55, v[1] - 28 * dt);
  if (down.jump && pl.onGround) { v[1] = 8.6; pl.onGround = false; Sfx.jump(); }
  const wasGround = pl.onGround, fallV = v[1];
  pl.onGround = false;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) * dt / 0.2));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) { moveAxis(1, v[1] * h); moveAxis(0, v[0] * h); moveAxis(2, v[2] * h); }
  if (!wasGround && pl.onGround && -fallV > 4) {
    const impact = -fallV;
    pl.dipAmt = Math.min(0.32, impact * 0.022); pl.dipT = 0;
    Sfx.land(blockBelow(), Math.min(1, impact / 20));
    if (impact > 12) player.shake = Math.max(player.shake, 0.08);
  }
  if (pl.pos[1] < -10) spawnPlayer(true);

  // camera feel
  const hs = Math.hypot(v[0], v[2]);
  pl.bobAmt = lerp(pl.bobAmt, pl.onGround ? Math.min(1, hs / 4.3) : 0, Math.min(1, 10 * dt));
  if (pl.onGround) {
    const before = Math.floor((pl.bobPhase + Math.PI / 2) / Math.PI);
    pl.bobPhase += hs * dt * 2.1;
    const after = Math.floor((pl.bobPhase + Math.PI / 2) / Math.PI);
    if (after !== before && hs > 0.8) Sfx.step(blockBelow());
  }
  pl.fovKick = lerp(pl.fovKick, (pl.sprinting && hs > 3) ? 1 : 0, Math.min(1, 8 * dt));
  pl.dipT = Math.min(1, pl.dipT + dt / 0.32);
  const eye = eyePos();
  const lit = isLit(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
  pl.light = lerp(pl.light, lit ? 1 : SHADOW + 0.12, Math.min(1, 5 * dt));
  const ex = clamp(Math.floor(eye[0]), 0, WX - 1), ez = clamp(Math.floor(eye[2]), 0, WZ - 1);
  pl.under = lerp(pl.under, world.top[ez * WX + ex] - eye[1] > 4 ? 1 : 0, Math.min(1, 1.5 * dt));
}

// Update
function update(dt) {
  time += dt;
  // camera blend between the menu orbit and the player's eyes
  const wantPlay = state === 'transition' || state === 'playing' || state === 'paused';
  camBlendLin = clamp(camBlendLin + (wantPlay ? dt / 1.5 : -dt / 1.2), 0, 1);
  if (state === 'transition' && camBlendLin >= 1) {
    state = 'playing';
    if (!locked) ui.click.classList.add('show');
  }
  if (state === 'menu') titleIntro += dt;
  const titleVisible = (state === 'menu' && (screen === 'scr-title' || screen === 'scr-play'));
  titleHide = lerp(titleHide, titleVisible ? 0 : 1, Math.min(1, 7 * dt));
  if (titleExplode >= 0) titleExplode = Math.min(1.2, titleExplode + dt / 1.1);

  if (state === 'playing') {
    updatePlayer(dt);
    target = raycast(eyePos(), lookDir(), 5.5);
    if (down.break && time - lastAct.break > 0.22) { lastAct.break = time; doBreak(); }
    if (down.place && time - lastAct.place > 0.22) { lastAct.place = time; doPlace(); }
    autosaveT += dt;
    if (autosaveT > 60) { autosaveT = 0; saveWorld(true); }
  } else if (state !== 'paused') target = null;

  if (state !== 'paused') {
    updateParticles(dt);
    for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t >= pops[i].dur) pops.splice(i, 1); }
    swingT = Math.min(1, swingT + dt / 0.26);
    equip = Math.max(0, equip - dt * 4);
    player.shake = Math.max(0, player.shake - dt * 0.6);
    player.fovPulse = Math.max(0, player.fovPulse - dt * 2);
    sway[0] *= Math.exp(-10 * dt); sway[1] *= Math.exp(-10 * dt);
  }
  // rebuild edited chunks
  for (const ch of chunks) if (ch.dirtyAt >= 0 && ch.dirtyAt <= time) meshChunk(ch);

  Sfx.ambience(dt, player.under, state === 'playing');

}

// Render
const SKY_ZEN = [0.36, 0.58, 0.96], SKY_HOR = [0.76, 0.86, 1.0];
const SUN = (() => { const v = [0.42, 0.42, -0.8], l = Math.hypot(...v); return v.map(c => c / l); })();
const IDENT = M4.ident();

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
function menuCamera() {
  const a = time * 0.035 + 0.6, r = 72;
  const eye = [WX / 2 + Math.sin(a) * r, 70, WZ / 2 + Math.cos(a) * r];
  const tgt = [WX / 2 + Math.sin(a + 0.6) * 20, 38, WZ / 2 + Math.cos(a + 0.6) * 20];
  const d = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]], l = Math.hypot(...d);
  return { eye, dir: d.map(c => c / l), roll: 0, fov: 70 };
}
function playerCamera() {
  const pl = player, dir = lookDir();
  const right = [Math.cos(pl.yaw), 0, -Math.sin(pl.yaw)];
  const bob = settings.bob ? pl.bobAmt : 0;
  const bx = Math.sin(pl.bobPhase) * 0.045 * bob, by = -Math.abs(Math.sin(pl.bobPhase)) * 0.07 * bob;
  const dip = Math.sin(pl.dipT * Math.PI) * pl.dipAmt;
  const e = eyePos();
  const eye = [e[0] + right[0] * bx, e[1] + by - dip, e[2] + right[2] * bx];
  const sh = pl.shake;
  if (sh > 0) { dir[0] += (Math.random() - 0.5) * sh * 0.25; dir[1] += (Math.random() - 0.5) * sh * 0.25; dir[2] += (Math.random() - 0.5) * sh * 0.25; }
  const fov = settings.fov * (1 + 0.12 * pl.fovKick + 0.25 * pl.fovPulse * pl.fovPulse);
  return { eye, dir, roll: Math.sin(pl.bobPhase) * 0.012 * bob, fov };
}

function render() {
  resize();
  const W = canvas.width, H = canvas.height, aspect = W / H;
  gl.viewport(0, 0, W, H);
  gl.clearColor(SKY_HOR[0], SKY_HOR[1], SKY_HOR[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!texArray) return;

  // ---- camera ----
  const mc = menuCamera(), pc = playerCamera();
  const b = easeInOut(camBlendLin);
  const eye = [0, 1, 2].map(i => lerp(mc.eye[i], pc.eye[i], b));
  let dir = [0, 1, 2].map(i => lerp(mc.dir[i], pc.dir[i], b));
  const dl = Math.hypot(...dir) || 1; dir = dir.map(c => c / dl);
  const fovDeg = lerp(mc.fov, pc.fov, b), roll = pc.roll * b;
  const right0 = [-dir[2], 0, dir[0]], rl = Math.hypot(...right0) || 1;
  const up = [right0[0] / rl * roll, 1, right0[2] / rl * roll];
  const fovy = fovDeg * Math.PI / 180;
  const proj = M4.persp(fovy, aspect, 0.05, 600);
  const view = M4.lookAt(eye, [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]], up);
  const vp = M4.mul(proj, view);
  const camR = [view[0], view[4], view[8]], camU = [view[1], view[5], view[9]], camF = [-view[2], -view[6], -view[10]];

  // ---- sky ----
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  gl.useProgram(progSky.p);
  const ty = Math.tan(fovy / 2);
  gl.uniform3fv(progSky.u.uF, camF); gl.uniform3fv(progSky.u.uR, camR); gl.uniform3fv(progSky.u.uU, camU);
  gl.uniform2f(progSky.u.uT, ty * aspect, ty);
  gl.uniform1i(progSky.u.uSunTex, 1);
  gl.uniform3fv(progSky.u.uSun, SUN); gl.uniform3fv(progSky.u.uZen, SKY_ZEN); gl.uniform3fv(progSky.u.uHor, SKY_HOR);
  gl.bindVertexArray(skyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);

  // ---- world ----
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  gl.useProgram(progWorld.p);
  const U = progWorld.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
  gl.uniform1i(U.uTex, 0);
  gl.uniformMatrix4fv(U.uVP, false, vp);
  gl.uniformMatrix4fv(U.uModel, false, IDENT);
  gl.uniform3fv(U.uCam, eye);
  gl.uniform3fv(U.uFog, SKY_HOR);
  const rd = settings.renderDist;
  gl.uniform2f(U.uFogRange, rd * 0.35, rd);
  gl.uniform1f(U.uLightMul, 1);
  gl.uniform4f(U.uFlash, 1, 1, 1, 0);
  const planes = frustumPlanes(vp);
  for (const ch of chunks) {
    if (!ch.count) continue;
    const x0 = ch.cx * CS, z0 = ch.cz * CS;
    const dx = Math.max(x0 - eye[0], 0, eye[0] - x0 - CS), dz = Math.max(z0 - eye[2], 0, eye[2] - z0 - CS);
    if (dx * dx + dz * dz > rd * rd) continue;
    if (!boxVisible(planes, x0, 0, z0, x0 + CS, WY, z0 + CS)) continue;
    gl.bindVertexArray(ch.vao);
    gl.drawElements(gl.TRIANGLES, ch.count, gl.UNSIGNED_INT, 0);
  }

  // ---- pop / crumble animations ----
  for (const p of pops) {
    const k = clamp(p.t / p.dur, 0, 1);
    const s = p.kind === 'place' ? lerp(0.55, 1, easeOutBack(k)) : (1 - k) * 0.9 + 0.05;
    gl.uniformMatrix4fv(U.uModel, false, M4.mul(M4.translate(p.x + 0.5, p.y + 0.5, p.z + 0.5), M4.scale(s)));
    gl.uniform1f(U.uLightMul, isLit(p.x, p.y + 1, p.z) ? 1 : SHADOW + 0.1);
    gl.uniform4f(U.uFlash, 1, 1, 1, (1 - k) * 0.55);
    const cube = cubeVAOs[p.type];
    gl.bindVertexArray(cube.vao); gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_INT, 0);
  }
  gl.uniformMatrix4fv(U.uModel, false, IDENT);
  gl.uniform1f(U.uLightMul, 1);
  gl.uniform4f(U.uFlash, 1, 1, 1, 0);

  // ---- particles ----
  if (particles.length) {
    let n = 0;
    const T = 3 / 16;
    for (const p of particles) {
      const s = p.size * Math.min(1, p.life / 0.25);
      const lt = isLit(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? 0.95 : SHADOW;
      const rx = camR[0] * s, ry = camR[1] * s, rz = camR[2] * s, ux = camU[0] * s, uy = camU[1] * s, uz = camU[2] * s;
      const c = [
        [p.x - rx - ux, p.y - ry - uy, p.z - rz - uz, p.u, p.v + T],
        [p.x + rx - ux, p.y + ry - uy, p.z + rz - uz, p.u + T, p.v + T],
        [p.x + rx + ux, p.y + ry + uy, p.z + rz + uz, p.u + T, p.v],
        [p.x - rx + ux, p.y - ry + uy, p.z - rz + uz, p.u, p.v],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const q = c[i];
        partData[n++] = q[0]; partData[n++] = q[1]; partData[n++] = q[2];
        partData[n++] = q[3]; partData[n++] = q[4]; partData[n++] = p.layer; partData[n++] = lt;
      }
    }
    gl.bindVertexArray(partVAO.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, partVAO.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, partData, 0, n);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, n / FLOATS);
    gl.enable(gl.CULL_FACE);
  }

  // ---- selection: outline + flashing face ----
  if (target && state === 'playing') drawSelection(vp);

  // ---- voxel title ----
  if (titleHide < 0.99 || (titleExplode >= 0 && titleExplode < 1.1)) drawTitle(aspect);

  // ---- held block ----
  if (camBlendLin > 0.6 && (state === 'playing' || state === 'paused' || state === 'transition')) drawHand(aspect);
}

function drawSelection(vp) {
  const { x, y, z, n } = target, e = 0.004;
  const x0 = x - e, y0 = y - e, z0 = z - e, x1 = x + 1 + e, y1 = y + 1 + e, z1 = z + 1 + e;
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  let k = 0;
  for (const i of E) { lineData[k++] = P[i][0]; lineData[k++] = P[i][1]; lineData[k++] = P[i][2]; }
  // face quad, nudged off the surface
  const F = FACES[faceIndexOf(n)];
  const q = F.c.map(C => [x + C.p[0] + n[0] * 0.006, y + C.p[1] + n[1] * 0.006, z + C.p[2] + n[2] * 0.006]);
  for (const i of [0, 1, 2, 0, 2, 3]) { lineData[k++] = q[i][0]; lineData[k++] = q[i][1]; lineData[k++] = q[i][2]; }
  gl.useProgram(progColor.p);
  gl.uniformMatrix4fv(progColor.u.uVP, false, vp);
  gl.bindVertexArray(lineVAO.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVAO.vbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData, 0, k);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false); gl.disable(gl.CULL_FACE);
  gl.uniform4f(progColor.u.uColor, 1, 1, 1, 0.1 + 0.09 * (0.5 + 0.5 * Math.sin(time * 9)));
  gl.drawArrays(gl.TRIANGLES, 24, 6);
  gl.uniform4f(progColor.u.uColor, 0.02, 0.02, 0.02, 0.6);
  gl.drawArrays(gl.LINES, 0, 24);
  gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
}

function drawTitle(aspect) {
  gl.clear(gl.DEPTH_BUFFER_BIT);
  const fovy = 40 * Math.PI / 180, tn = Math.tan(fovy / 2);
  const D = Math.max(titleHalfW / (0.78 * tn * aspect), 3.6 / (0.24 * tn));
  const sw = Math.sin(time * 0.45) * 0.12;
  const eye = [Math.sin(sw) * D, D * 0.3, Math.cos(sw) * D];
  const vp = M4.mul(M4.persp(fovy, aspect, 1, 800), M4.lookAt(eye, [0, 0, 0], [0, 1, 0]));
  const U = progTitle.u;
  gl.useProgram(progTitle.p);
  gl.uniformMatrix4fv(U.uVP, false, vp);
  gl.uniform1i(U.uTex, 0);
  gl.uniform1f(U.uTime, time);
  gl.uniform1f(U.uIntro, titleIntro);
  gl.uniform1f(U.uExplode, Math.max(0, titleExplode));
  gl.uniform1f(U.uOffY, 0.4 + smooth(clamp(titleHide, 0, 1)) * 1.4 * (titleExplode >= 0 ? 0 : 1));
  gl.uniform1f(U.uAspect, aspect);
  gl.uniform1f(U.uHalfW, titleHalfW);
  gl.uniform2f(U.uMouse, mouseNdc[0], mouseNdc[1]);
  gl.bindVertexArray(titleMesh.vao);
  gl.drawElements(gl.TRIANGLES, titleMesh.count, gl.UNSIGNED_INT, 0);
}

function drawHand(aspect) {
  gl.clear(gl.DEPTH_BUFFER_BIT);
  const pl = player, type = HOTBAR[slot];
  const bob = settings.bob ? pl.bobAmt : 0;
  const sw = swingT < 1 ? Math.sin(swingT * Math.PI) : 0;
  const sw2 = swingT < 1 ? Math.sin(Math.sqrt(swingT) * Math.PI) : 0;
  const enter = 1 - easeInOut(clamp((camBlendLin - 0.6) / 0.4, 0, 1));
  const drop = equip * equip * 0.55 + enter * 0.9;
  const hx = 0.62 + Math.sin(pl.bobPhase) * 0.035 * bob - sw2 * 0.22 - clamp(sway[0], -0.15, 0.15);
  const hy = -0.6 - Math.abs(Math.cos(pl.bobPhase)) * 0.03 * bob - drop - sw * 0.12 + clamp(sway[1], -0.12, 0.12);
  const hz = -1.0 - sw * 0.22;
  const model = M4.chain(M4.translate(hx, hy, hz), M4.rotX(-sw * 0.85), M4.rotY(0.78 - sw2 * 0.35), M4.rotX(0.08), M4.scale(0.42));
  const U = progWorld.u;
  gl.useProgram(progWorld.p);
  gl.uniformMatrix4fv(U.uVP, false, M4.persp(70 * Math.PI / 180, aspect, 0.01, 10));
  gl.uniformMatrix4fv(U.uModel, false, model);
  gl.uniform3f(U.uCam, 0, 0, 0);
  gl.uniform2f(U.uFogRange, 1000, 2000);
  gl.uniform1f(U.uLightMul, pl.light);
  gl.uniform4f(U.uFlash, 1, 1, 1, 0);
  const cube = cubeVAOs[type];
  gl.bindVertexArray(cube.vao); gl.drawElements(gl.TRIANGLES, cube.count, gl.UNSIGNED_INT, 0);
  gl.uniformMatrix4fv(U.uModel, false, IDENT);
}

// Main loop & boot
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

async function boot() {
  showScreen('scr-loading');
  await loadPixelFont();
  setLoading('Loading textures...', 0.02);
  try {
    await loadTextures();
  } catch (e) {
    const fileProto = location.protocol === 'file:';
    fatal(fileProto
      ? 'Your browser blocks WebGL from reading images when the page is opened straight from disk.<br><br>' +
        'Start a tiny local server inside the <b>MinePlace</b> folder and open it from there:<br><br>' +
        '<code>python3 -m http.server 8000</code><br><br>then visit <code>http://localhost:8000</code>'
      : 'Could not load <code>img/grasstexture.png</code> and <code>img/cobblestonetexture.png</code>.<br>' + String(e.message));
    return;
  }
  initDynamic();
  buildHotbar();
  requestAnimationFrame(frame);

  let saved = null;
  try { saved = await DB.get('main'); } catch (e) { saved = null; }
  if (saved && saved.blocks && saved.blocks.length === WX * WY * WZ) {
    setLoading('Loading your world...', 0.4);
    world.blocks.set(saved.blocks);
    world.seed = saved.seed | 0; world.type = saved.type || 'hills';
    recomputeTops();
    await meshAll(p => setLoading('Building chunks...', 0.4 + p * 0.6));
    const sp = saved.player || {};
    if (sp.pos) { player.pos = sp.pos.slice(); player.yaw = sp.yaw || 0; player.pitch = sp.pitch || 0; }
    else spawnPlayer(false);
    selectSlot(saved.slot || 0, true);
    hasSave = true; world.fresh = false;
  } else {
    await buildWorld('hills', (Math.random() * 2147483647) | 0);
    spawnPlayer(false);
  }
  updateMenuButtons();
  state = 'menu';
  titleIntro = 0;
  showScreen('scr-title');
  ui.fade.style.opacity = 0;
}
boot();

})();
