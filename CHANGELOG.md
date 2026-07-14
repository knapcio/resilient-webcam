# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-07-14

### Fixed

- Added the conventional top-level `module` entry so bundlers that do not fully honor `exports` can still resolve the ESM source entry.

## [0.1.1] - 2026-07-14

### Fixed

- Hardened start and restart cancellation across observer callbacks and asynchronous stream adoption so stopped or destroyed controllers cannot reopen the camera or overwrite terminal states.
- Retired cancelled single-flight operations synchronously and prevented observer cleanup from leaving stale recovery timers or waiters.
- Kept frame-watchdog updates disabled when no monitor is active and resumed deferred frame-stall retries when no live stream remains.
- Cleared stale hidden-document recovery after manual starts, preserved literal `ErrorCodes` declaration types, and made syntax checks work from file paths containing spaces or non-ASCII characters.

### Security

- Restricted the network-accessible demo server to explicit demo, source, and README paths instead of exposing the repository root.

## [0.1.0] - 2026-07-14

### Added

- Framework-neutral webcam lifecycle controller with bounded automatic recovery.
- Recovery signals for ended and muted tracks, device changes, and frame stalls.
- Stale-request cleanup, request timeouts, backoff, jitter, and single-flight restarts.
- Async canvas capture with optional near-black detection and one restart/recapture.
- TypeScript declarations, browser demo, tests, and public project documentation.

[Unreleased]: https://github.com/knapcio/resilient-webcam/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/knapcio/resilient-webcam/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/knapcio/resilient-webcam/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/knapcio/resilient-webcam/releases/tag/v0.1.0
