# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.4] — 2026-11-24

### Changed

- Both screenshots now sit at the very top of the README, stacked and centred
  above the install prompt, so a visitor sees the pill and the panel it opens
  without scrolling and both stay readable. No other content changed.

## [1.4.3] — 2026-11-24

### Changed

- Both screenshots moved to the repository root and the panel capture now sits
  centred at the top of the README, so a visitor sees the result before reading
  anything. The pill image stays a render from the plugin's stylesheet so no live
  Session amounts are published; the panel image is a real capture.

## [1.4.2] — 2026-11-24

### Changed

- The panel image under **What you see** is now a real capture of the panel that
  opens when the usage pill is clicked (one OpenCode Go session), so the README
  shows the exact result instead of a rendered preview. The pill image at the top
  stays a render from the plugin's stylesheet, because a live capture of it would
  show a real Session's amounts.

## [1.4.1] — 2026-11-24

### Added

- An **Install with your AI** section at the top of the README: one copy-paste
  prompt that tells a coding agent how to install this plugin into the running
  DeepSeek Harness profile, how to verify it, and which step to report if the
  machine cannot run it.
- Two preview images (`docs/preview.png`, `docs/preview-panel.png`) rendered from
  the plugin's own stylesheet with sample values, so the README shows the pill
  and the expanded panel without exposing anyone's Session.

## [1.4.0] — 2026-11-24

First public release. Previously developed and installed privately; nothing in
the meter changed for its users except the package name and the install path.

### Added

- `README.md` with install, update, configuration, privacy and troubleshooting
  sections, and `SECURITY.md` with a private reporting route.
- Public release tooling: the package is installable and updatable from the
  DeepSeek Harness **Plugins** page (registry installs only).
- A one-megabyte cap on every upstream reply, so a broken or hostile origin
  cannot exhaust Host memory.
- `X-Content-Type-Options: nosniff` on the plugin's JSON and error replies, a
  generic message for internal errors, and a bounded length for upstream status
  labels shown in the panel.
- Tests stay in the repository and out of the published package.

### Changed

- Package, module and plugin names: `deepseek-harness-cost` (the Host route stays
  `/chat-cost/api`, the locale namespace stays `chat-cost`, and the projection
  key stays `chatCost`, so existing Sessions keep their numbers).
- `usd.modelsPath` and `usd.usagePaths` must be plain origin-relative paths; a
  value that would re-target the request (for example `//elsewhere` or
  `@elsewhere`) is ignored and the default is used.
- The allowance route now fails closed: a Host without the Connection fence
  (Host/Origin check plus browser authentication) gets no route at all instead of
  an unauthenticated one.

### Earlier, private history

These milestones were developed before the public repository and carry no public
tag: first meter under the composer, realized rate per 1K tokens, subagent
aggregation, an independent audit of the displayed amount, and provider-aware
CNY/USD pricing with OpenCode Go allowance windows (1.3.0).

## Unreleased

Nothing yet.
