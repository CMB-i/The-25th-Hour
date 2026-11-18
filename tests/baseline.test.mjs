import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('starter: GitHub Pages has a root HTML entry point', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /The 25th Hour/i);
});
