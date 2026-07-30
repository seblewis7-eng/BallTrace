import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("continues searching after the first lost frame", () => {
  assert.match(app, /REACQUIRE_WINDOW_FRAMES = 18/);
  assert.match(app, /searchState\.searchFrames < REACQUIRE_WINDOW_FRAMES/);
  assert.match(app, /reacquisitions/);
});

test("builds a separate estimated trajectory", () => {
  assert.match(app, /BallTraceTrajectory\.buildPredictedTrajectory/);
  assert.match(app, /state\.predictedPoints/);
  assert.match(app, /dashed gold is the rough continuation/);
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
