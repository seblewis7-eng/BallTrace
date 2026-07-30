import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("tracking pauses each presented frame before worker analysis", () => {
  assert.match(app, /function presentOneFrame/);
  assert.match(app, /const finished = \(metadata\) => \{\s*ui\.sourceVideo\.pause\(\);/);
  assert.match(app, /const metadata = await advanceToNextPresentedFrame/);
  assert.match(app, /const frame = captureFrame\(\);\s*const reply = await workerMessage/);
});

test("tracking uses actual decoded media times", () => {
  assert.match(app, /metadata\.mediaTime \?\? ui\.sourceVideo\.currentTime/);
  assert.match(app, /time: mediaTime/);
  assert.match(app, /metadata\.presentedFrames/);
});

test("selection builds a colour-isolated template before tracking", () => {
  assert.match(app, /BallTraceCore\.samplePatch/);
  assert.match(app, /template: state\.selectionTemplate/);
  assert.match(app, /selectedClass === "yellow"/);
});
