const grid = document.getElementById("grid");
const status = document.getElementById("status");
const search = document.getElementById("search");
let games = [];

function render() {
  const q = search.value.trim().toLowerCase();
  const shown = games.filter((g) => (g.title + " " + g.description).toLowerCase().includes(q));
  grid.replaceChildren(...shown.map(card));
  status.textContent = games.length === 0
    ? "No games yet. Add one to the games/ folder and push."
    : shown.length === 0 ? "No matches." : "";
}

function card(g) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = "play.html?game=" + encodeURIComponent(g.slug);

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (g.thumbnail) {
    const img = document.createElement("img");
    img.src = g.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    thumb.append(img);
  } else {
    thumb.textContent = g.title.charAt(0).toUpperCase();
    thumb.style.background = `hsl(${hash(g.slug) % 360} 55% 40%)`;
  }

  const title = document.createElement("h2");
  title.textContent = g.title;
  a.append(thumb, title);
  if (g.description) {
    const p = document.createElement("p");
    p.textContent = g.description;
    a.append(p);
  }
  return a;
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// Easter egg: click the title 3 times quickly for a jumpscare
const logo = document.getElementById("logo");
const scare = document.getElementById("scare");
const staticCanvas = document.getElementById("static");
let clicks = 0;
let clickTimer;
let scareTimers = [];
let audio;

logo.addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clicks = 0; }, 1500);
  if (++clicks < 3) return;
  clicks = 0;
  jumpscare();
});
scare.addEventListener("click", endScare);

function jumpscare() {
  if (scare.classList.contains("show")) return;
  scare.hidden = false;
  scare.className = "show";
  scream();
  drawStatic();
  scareTimers = [
    setTimeout(() => scare.classList.add("after"), 1300), // screech over, static + flicker
    setTimeout(() => scare.classList.add("fade"), 3000),
    setTimeout(endScare, 3500),
  ];
}

function endScare() {
  scareTimers.forEach(clearTimeout);
  scare.className = "";
  scare.hidden = true;
  if (audio) { audio.close(); audio = null; }
}

// TV static, redrawn every frame while the scare is showing
function drawStatic() {
  if (!scare.classList.contains("show")) return;
  const ctx = staticCanvas.getContext("2d");
  const img = ctx.createImageData(staticCanvas.width, staticCanvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  requestAnimationFrame(drawStatic);
}

// A distorted screech made with Web Audio, then static hiss
function scream() {
  audio = new AudioContext();
  const now = audio.currentTime;
  const out = audio.createGain();
  out.gain.value = 0.5;
  out.connect(audio.destination);

  const distort = audio.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 512 - 1) * 8);
  distort.curve = curve;
  const screechGain = audio.createGain();
  screechGain.gain.setValueAtTime(0, now);
  screechGain.gain.linearRampToValueAtTime(1, now + 0.03);
  screechGain.gain.setValueAtTime(1, now + 1.1);
  screechGain.gain.linearRampToValueAtTime(0, now + 1.3);
  distort.connect(screechGain).connect(out);

  for (const f of [420, 560, 690, 830]) {
    const osc = audio.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f * 0.6, now);
    osc.frequency.exponentialRampToValueAtTime(f, now + 0.15);
    osc.frequency.exponentialRampToValueAtTime(f * 0.8, now + 1.3);
    const wobble = audio.createOscillator();
    const wobbleDepth = audio.createGain();
    wobble.frequency.value = 25 + Math.random() * 15;
    wobbleDepth.gain.value = f * 0.08;
    wobble.connect(wobbleDepth).connect(osc.frequency);
    osc.connect(distort);
    osc.start(now); wobble.start(now);
    osc.stop(now + 1.3); wobble.stop(now + 1.3);
  }

  const noise = audio.createBuffer(1, audio.sampleRate * 3.5, audio.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const hiss = audio.createBufferSource();
  hiss.buffer = noise;
  const hissGain = audio.createGain();
  hissGain.gain.setValueAtTime(0.6, now);
  hissGain.gain.setValueAtTime(0.6, now + 1.3);
  hissGain.gain.linearRampToValueAtTime(0.15, now + 1.4);
  hissGain.gain.linearRampToValueAtTime(0, now + 3.5);
  hiss.connect(hissGain).connect(out);
  hiss.start(now);
}

search.addEventListener("input", render);
fetch("games.json", { cache: "no-store" })
  .then((r) => r.json())
  .then((data) => { games = data; render(); })
  .catch(() => { status.textContent = "Couldn't load games.json"; });
