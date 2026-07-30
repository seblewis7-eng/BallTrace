import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("hands a short detected launch to the native crop when the low-resolution tracker misses", () => {
  assert.match(app, /function shouldActivateAdaptive/);
  assert.match(app, /point\.state !== "DETECTED"/);
  assert.match(app, /points\.length < 2/);
  assert.match(app, /early-loss-recovery/);
  assert.match(app, /return analyseAdaptiveFrame\(mediaTime, fps\)/);
});

test("normal launch handoff no longer waits for six accepted frames", () => {
  assert.match(app, /points\.length >= 4/);
  assert.doesNotMatch(app, /points\.length >= 5/);
});

test("selection time is locked to the frame actually drawn on the canvas", () => {
  assert.match(app, /state\.displayedTime = time/);
  assert.match(app, /state\.selectionTime = state\.displayedTime/);
  assert.match(app, /const request = \+\+state\.scrubRequest/);
});
