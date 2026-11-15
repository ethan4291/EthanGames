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
let clicks = 0;
let clickTimer;
logo.addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clicks = 0; }, 1500);
  if (++clicks < 3) return;
  clicks = 0;
  scare.classList.remove("show");
  void scare.offsetWidth; // restart the animation
  scare.classList.add("show");
  setTimeout(() => scare.classList.remove("show"), 1600);
});
scare.addEventListener("click", () => scare.classList.remove("show"));

search.addEventListener("input", render);
fetch("games.json", { cache: "no-store" })
  .then((r) => r.json())
  .then((data) => { games = data; render(); })
  .catch(() => { status.textContent = "Couldn't load games.json"; });
