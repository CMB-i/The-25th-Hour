# Chromium smoke test

Start the local HTTP server from the repository root, then run
`node tests/ui/browser-smoke.mjs` with Node.js 22+ and Chromium. Set
`CHROMIUM` or `TEST_ORIGIN` to override the executable or server address.
The test exercises T21–T24 in a temporary browser profile.
