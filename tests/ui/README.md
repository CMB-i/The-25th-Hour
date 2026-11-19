# Chromium smoke test (T21–T24)

Start the local HTTP server from the repository root, then run
`node tests/ui/browser-smoke.mjs` (or `npm run test:ui`) with Node.js 22+ and Chrome/Chromium.
Set `CHROMIUM` or `TEST_ORIGIN` to override the browser executable or server address
(on macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` is auto-detected when `CHROMIUM` is unset; set `CHROMIUM_NO_SANDBOX=1` in sandboxed/CI environments).
The suite exercises acceptance tests T21–T24 across all 5 screens in an isolated browser profile.
