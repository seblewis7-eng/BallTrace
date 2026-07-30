import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

class FakeTracker {
  constructor(settings = {}) {
    this.settings = { maxPredictedGapFrames: 5, ...settings };
    this.reset();
  }

  reset() {
    this.previousFrame = new Uint8ClampedArray(4);
    this.position = { x: 0, y: 0 };
    this.smoothed = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
    this.previousTime = 0;
    this.missedFrames = 0;
    this.launched = false;
    this.width = 500;
    this.height = 500;
    this.queue = [];
  }

  initialize({ x, y, time = 0 }) {
    this.position = { x, y };
    this.smoothed = { x, y };
    this.previousTime = time;
    return { state: "DETECTED", x, y, smoothX: x, smoothY: y, time, launched: false };
  }

  track({ frame, time }) {
    const point = this.queue.shift();
    if (!point) throw new Error("Missing fake tracker point.");
    const dt = Math.max(1 / 240, time - this.previousTime);
    const previous = { ...this.position };
    this.position = { x: point.x, y: point.y };
    this.smoothed = { x: point.x, y: point.y };
    this.velocity = { x: (point.x - previous.x) / dt, y: (point.y - previous.y) / dt };
    this.previousTime = time;
    this.previousFrame = new Uint8ClampedArray(frame);
    this.launched = point.launched ?? true;
    this.missedFrames = 0;
    return { state: "DETECTED", x: point.x, y: point.y, smoothX: point.x, smoothY: point.y, time, confidence: 0.9, launched: this.launched };
  }
}

globalThis.BallTraceCore = Object.freeze({ Tracker: FakeTracker });
globalThis.BallTraceTrajectory = Object.freeze({
  buildPredictedTrajectory({ points }) { return points; },
});
await import("../tracking-guard.js");

const GuardedTracker = globalThis.BallTraceCore.Tracker;
const frame = new Uint8ClampedArray(4);

test("keeps a consistent upward launch", () => {
  const tracker = new GuardedTracker();
  tracker.initialize({ x: 400, y: 430, time: 0 });
  tracker.queue.push(
    { x: 360, y: 360, launched: true },
    { x: 315, y: 285, launched: true },
    { x: 275, y: 225, launched: true },
  );
  assert.equal(tracker.track({ frame, time: 1 / 30 }).state, "DETECTED");
  assert.equal(tracker.track({ frame, time: 2 / 30 }).state, "DETECTED");
  assert.equal(tracker.track({ frame, time: 3 / 30 }).state, "DETECTED");
});

test("rejects a sharp turn toward another range ball", () => {
  const tracker = new GuardedTracker();
  tracker.initialize({ x: 400, y: 430, time: 0 });
  tracker.queue.push(
    { x: 360, y: 360, launched: true },
    { x: 315, y: 285, launched: true },
    { x: 390, y: 330, launched: true },
  );
  tracker.track({ frame, time: 1 / 30 });
  tracker.track({ frame, time: 2 / 30 });
  const rejected = tracker.track({ frame, time: 3 / 30 });
  assert.equal(rejected.state, "PREDICTED");
  assert.equal(rejected.guardRejected, true);
  assert.ok(rejected.x < 315);
  assert.ok(rejected.y < 285);
});

test("filters dog-leg detections before prediction", () => {
  const points = [
    { state: "DETECTED", x: 400, y: 430, smoothX: 400, smoothY: 430, time: 0 },
    { state: "DETECTED", x: 360, y: 360, smoothX: 360, smoothY: 360, time: 1 / 30 },
    { state: "DETECTED", x: 315, y: 285, smoothX: 315, smoothY: 285, time: 2 / 30 },
    { state: "DETECTED", x: 390, y: 330, smoothX: 390, smoothY: 330, time: 3 / 30 },
    { state: "DETECTED", x: 275, y: 225, smoothX: 275, smoothY: 225, time: 4 / 30 },
  ];
  const filtered = globalThis.BallTraceCore.consistentDetectedPoints(points);
  assert.equal(filtered.length, 4);
  assert.ok(!filtered.some((point) => point.x === 390));
});

test("Safari fallback advances by one 30 fps frame before the app timeout", async () => {
  const source = await readFile(new URL("../safari-frame-fallback.js", import.meta.url), "utf8");
  assert.match(source, /currentTime \+ 1 \/ 30/);
  assert.match(source, /}, 1400\)/);
  assert.match(source, /seeked/);
});
