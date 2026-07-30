import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("continues searching for roughly six tenths of a second at any frame rate", () => {
  assert.match(app, /function reacquireWindowFrames/);
  assert.match(app, /state\.frameRate\.fps \* 0\.6/);
  assert.match(app, /searchState\.searchFrames < reacquireWindowFrames\(\)/);
  assert.match(app, /reacquisitions/);
});

test("builds a separate estimated trajectory using measured fps", () => {
  assert.match(app, /BallTraceTrajectory\.buildPredictedTrajectory/);
  assert.match(app, /state\.predictedPoints/);
  assert.match(app, /fps: state\.frameRate\.fps/);
  assert.match(app, /dashed gold is estimated/);
});

test("draws measured and estimated traces differently", () => {
  assert.match(app, /point\.state === "DETECTED"/);
  assert.match(app, /rgba\(255,181,71,.9\)/);
  assert.match(app, /dash: \[11, 8\]/);
});

test("export includes the estimated continuation", () => {
  assert.match(app, /function traceEndTime/);
  assert.match(app, /const end = traceEndTime\(\)/);
});
