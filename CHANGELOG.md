# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-14

### Added

- Framework-neutral webcam lifecycle controller with bounded automatic recovery.
- Recovery signals for ended and muted tracks, device changes, and frame stalls.
- Stale-request cleanup, request timeouts, backoff, jitter, and single-flight restarts.
- Async canvas capture with optional near-black detection and one restart/recapture.
- TypeScript declarations, browser demo, tests, and public project documentation.

[Unreleased]: https://github.com/knapcio/resilient-webcam/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/knapcio/resilient-webcam/releases/tag/v0.1.0
