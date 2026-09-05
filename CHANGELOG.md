# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Fixed repairs applying outdated release files when Sync changes the installed manifest identity or version after a check or during repair.
- Fixed stalled repair downloads holding the repair lock indefinitely. Downloads now time out after two minutes per file, clean up staged files, and ignore late responses.
- Fixed corrupted `main.js` files with Obsidian's `nosourcemap` suffix being reported as repairable but repeatedly rejected as changed before repair.
- Fixed disabling and re-enabling Sync Assets being treated as an Obsidian restart, allowing repair backups to be deleted too early.

## [1.0.2] - 2026-09-03

### Improved

- Improved **integrity check scope** so startup and manual checks read only explicitly monitored plugins, while Settings continues to inventory every installed community plugin.
- Improved **mobile network reliability** with bounded retries and timeouts for small GitHub metadata requests, `Retry-After` handling, and a batch circuit breaker that stops redundant requests after connectivity is exhausted.
- Improved **mobile integrity verification** by processing artifact buffers and SHA-256 work sequentially, yielding between files, and showing the active plugin and file while verification is running.
- Improved **late Sync handling** so startup checks use current settings and run one refreshed check after a monitored repository change remains stable for five seconds during the initial three-minute window.

### Fixed

- Fixed unmonitored plugins with missing, malformed, or unreadable manifests appearing in integrity results or triggering network requests, Notices, or the results modal.
- Fixed Android and iOS connectivity failures appearing as generic **Check failed** results. Connection, timeout, temporary GitHub service, rate-limit, unsupported-response, and unexpected failures now have distinct user-facing states, while platform exception text remains under **Technical details**.
- Fixed automatic checks opening the results modal for availability-only failures. Automatic checks now show at most one short Notice per app session, while manual checks continue to open the modal and offer **Try again** when appropriate.
- Fixed late read-only check completions updating state or starting UI, repair-journal reconciliation, or cleanup after a timeout or plugin unload.
