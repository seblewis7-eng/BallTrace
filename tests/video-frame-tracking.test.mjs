import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const core = await readFile(new URL("../tracker-core.js", import.meta.url), "utf8");
const adaptive = await readFile(new URL("../adaptive-source-tracker.js", import.meta.url), "utf8");

test("tracks actual decoded video frames when supported", () => {
  assert.match(app, /requestVideoFrameCallback/);
  assert.match(app, /trackPresentedFrames/);
  assert.match(app, /metadata\.mediaTime/);
});

test("measures decoded frame rate instead of forcing 30 or 60 fps", () => {
  assert.match(app, /FrameRateEstimator/);
  assert.match(app, /state\.frameRate\.add\(time\)/);
  assert.match(app, /state\.frameRate\.frameDuration/);
  assert.match(adaptive, /class FrameRateEstimator/);
});

test("keeps a lower-resolution launch finder then switches to a native crop", () => {
  assert.match(app, /900\s*\/\s*Math\.max/);
  assert.match(app, /function captureSourceCrop/);
  assert.match(app, /AdaptiveSourceTracker/);
  assert.match(app, /sourceCrop\.drawImage\(ui\.sourceVideo, originX, originY, width, height/);
});

test("tracker includes a sufficiently wide first-launch search", () => {
  const radius = Number(core.match(/launchSearchRadius:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(radius));
  assert.ok(radius >= 260, `launch search radius ${radius} is too small for a 30 fps first-frame jump`);
  assert.match(core, /mode:\s*"launch"/);
  assert.match(core, /wideGridStep/);
});
