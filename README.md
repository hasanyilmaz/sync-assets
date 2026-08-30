# Sync Assets

Sync Assets is an Obsidian community plugin project focused on detecting and repairing oversized plugin `main.js` release assets that Obsidian Sync may skip.

## Status

Project scaffold only. Repository checks, startup checks, integrity verification, repair transactions, settings, and user interface behavior are intentionally not implemented yet. Those behaviors will be designed and approved in this project's own planning workflow.

## Settled boundaries

- Mobile-compatible community plugin (`isDesktopOnly: false`).
- User-configured GitHub repository roots.
- Manual checks and optional startup checks.
- Explicit user approval before every repair.
- Exact-release size and SHA-256 verification before replacement.
- Temporary download, backup, verified replacement, and restart handoff.
- No modification of target-plugin `data.json`, state, runtime, cache, or vault content.

## Development

```bash
npm install
npm run dev
```

Production validation:

```bash
npm run check
```

The canonical checkout stays on `main`. Feature development will use dedicated branches and Git worktrees.
