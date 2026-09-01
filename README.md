# Sync Assets

Sync Assets checks and repairs incomplete or mismatched Obsidian community
plugin files across your devices.

## Why Sync Assets?

[Obsidian Sync Standard limits individual files to 5 MB](https://obsidian.md/help/sync/plans).
If a community plugin has a larger `main.js`, that file may not reach another
device even when its smaller `manifest.json` and `styles.css` files do.

Sync Assets detects this kind of partial installation and restores the exact
files published for the installed plugin version. It can also help when another
file-sync service leaves community plugin files missing or inconsistent.

## How to use it

1. Open **Settings → Sync Assets**.
2. Choose the installed plugins you want to monitor.
3. Keep **Check automatically at startup** enabled, or run a manual check.
4. If a problem is found, review it and choose **Repair** or, when available,
   **Repair and reload Obsidian**.

Healthy startup checks stay quiet. During the first three minutes after startup,
Sync Assets also watches for plugin files that arrive late through sync. Repair
always requires your confirmation.

## Command Palette

- **Sync Assets: Check plugin integrity**: Starts a new integrity check at any
  time, including when automatic startup checks are disabled.

## How it works

Sync Assets reads the installed plugin version, finds the matching release in
the plugin's public GitHub repository, and verifies `main.js`, `manifest.json`,
and `styles.css` using file size and SHA-256.

Before a repair, every required file is downloaded, verified, and staged. The
current files are backed up before replacement, and a failed repair is rolled
back whenever it is safe to do so.

Sync Assets is an integrity and recovery tool. It does not upgrade or downgrade
plugins.

## Safety

Sync Assets never modifies a monitored plugin's settings, `data.json`, runtime
state, cache, or other plugin-owned files. It does not accept custom download
URLs, access tokens, or private repositories.

Repository information for normal community plugins comes from Obsidian's
official community catalog. BRAT and development plugins may require a manual
GitHub `owner/repo` entry.

Sync Assets works on desktop and mobile. A repaired `manifest.json` requires a
full Obsidian restart; eligible desktop repairs can offer an automatic app
reload.

## Development

```bash
npm install
npm run check
```

`npm run lint:report` shows every ESLint diagnostic, while
`npm run lint:strict` fails on warnings. `npm run release:guard` verifies the
version contract, release artifacts, MIT license, ignore policy, and production
bundle hygiene after a build.

## License

Sync Assets is available under the [MIT License](LICENSE).
