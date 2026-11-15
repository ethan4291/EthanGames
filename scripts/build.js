// Builds the site into dist/: copies site/ + games/, and writes games.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const siteDir = path.join(root, "site");
const dist = path.join(root, "dist");
const THUMB_NAMES = ["thumbnail", "thumb", "cover", "icon"];
const THUMB_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(siteDir, dist, { recursive: true });
fs.mkdirSync(gamesDir, { recursive: true });
fs.cpSync(gamesDir, path.join(dist, "games"), { recursive: true });
fs.writeFileSync(path.join(dist, ".nojekyll"), "");

// Cache-bust: make browsers fetch fresh CSS/JS after every deploy
const version = Date.now().toString(36);
for (const page of ["index.html", "play.html"]) {
  const file = path.join(dist, page);
  const html = fs.readFileSync(file, "utf8").replace(/(href|src)="(style\.css|app\.js)"/g, `$1="$2?v=${version}"`);
  fs.writeFileSync(file, html);
}

const titleFromHtml = (file) => {
  const m = fs.readFileSync(file, "utf8").match(/<title[^>]*>([^<]*)<\/title>/i);
  return m && m[1].trim();
};
const prettify = (slug) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const games = [];
for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
  if (entry.name.startsWith(".")) continue;
  const full = path.join(gamesDir, entry.name);

  if (entry.isFile() && /\.html?$/i.test(entry.name)) {
    // A single-file game: games/my-game.html
    const slug = entry.name.replace(/\.html?$/i, "");
    games.push({
      slug,
      title: titleFromHtml(full) || prettify(slug),
      description: "",
      url: `games/${encodeURIComponent(entry.name)}`,
      thumbnail: null,
      updated: fs.statSync(full).mtime.toISOString(),
    });
    continue;
  }
  if (!entry.isDirectory()) continue;

  // A folder game: games/my-game/index.html (+ optional game.json and thumbnail.png)
  const indexFile = ["index.html", "index.htm"].find((f) => fs.existsSync(path.join(full, f)));
  if (!indexFile) {
    console.warn(`Skipping games/${entry.name}: no index.html`);
    continue;
  }
  let meta = {};
  const metaFile = path.join(full, "game.json");
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); }
    catch (e) { console.warn(`Bad JSON in games/${entry.name}/game.json: ${e.message}`); }
  }
  let thumbnail = meta.thumbnail || null;
  if (!thumbnail) {
    const files = fs.readdirSync(full);
    thumbnail = files.find((f) => {
      const { name, ext } = path.parse(f.toLowerCase());
      return THUMB_NAMES.includes(name) && THUMB_EXTS.includes(ext);
    }) || null;
  }
  const base = `games/${encodeURIComponent(entry.name)}/`;
  games.push({
    slug: entry.name,
    title: meta.title || titleFromHtml(path.join(full, indexFile)) || prettify(entry.name),
    description: meta.description || "",
    url: base + indexFile,
    thumbnail: thumbnail ? base + thumbnail : null,
    updated: fs.statSync(path.join(full, indexFile)).mtime.toISOString(),
  });
}

games.sort((a, b) => a.title.localeCompare(b.title));
fs.writeFileSync(path.join(dist, "games.json"), JSON.stringify(games, null, 2));
console.log(`Built ${games.length} game(s) into dist/`);
