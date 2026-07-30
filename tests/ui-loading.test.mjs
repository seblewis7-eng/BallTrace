import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, app, serviceWorker] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../sw.js", import.meta.url), "utf8"),
]);

test("hidden UI cannot be revived by component display rules", () => {
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.empty-state\{[^}]*pointer-events:none/);
});

test("the source video remains decodable while visually offscreen", () => {
  assert.match(html, /id="sourceVideo"[^>]*class="source-video"/);
  assert.match(html, /id="sourceVideo"[^>]*muted[^>]*preload="auto"/);
  const sourceVideoTag = html.match(/<video\s+[^>]*id="sourceVideo"[^>]*>/)?.[0] || "";
  assert.ok(sourceVideoTag);
  assert.doesNotMatch(sourceVideoTag, /(?:^|\s)hidden(?:\s|=|>)/);
  assert.match(css, /\.source-video\{/);
});

test("upload waits for a decoded frame before enabling interaction", () => {
  assert.match(app, /waitForMetadata/);
  assert.match(app, /waitForDecodedFrame/);
  assert.match(app, /await seek\(0, true\)/);
  assert.match(app, /await drawDecodedFrame\(\)/);
  assert.match(app, /ui\.emptyState\.hidden = true/);
});

test("service worker cache was advanced for the frame processing repair", () => {
  assert.match(serviceWorker, /balltrace-v5/);
});
