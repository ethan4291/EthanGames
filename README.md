# Ethan Games

A simple personal game site, deployed to GitHub Pages by GitHub Actions.

## Adding a game

Either:

- **Folder game:** `games/my-game/index.html` (plus any JS, images, sounds it uses). If the folder has only one `.html` file, it can have any name.
- **Single file:** `games/my-game.html`

Then commit and push (or use GitHub's **Add file → Upload files** inside the `games/` folder). The site rebuilds automatically.

Optional extras for folder games:

- `thumbnail.png` (or `.jpg`/`.webp`/`.gif`/`.svg`, also `cover.*`/`icon.*`) — shown on the card
- `game.json` — `{ "title": "...", "description": "..." }`

If there's no `game.json`, the title comes from the game's `<title>` tag, then the folder name.

Games must use **relative paths** (`./sprite.png`, not `/sprite.png`), since the site lives under `/<repo-name>/`.

## One-time setup

1. Create a GitHub repo and push this folder to the `main` branch.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Your site will be at `https://<username>.github.io/<repo-name>/`.

## Preview locally

```
npm run dev
```

Then open http://localhost:8080
