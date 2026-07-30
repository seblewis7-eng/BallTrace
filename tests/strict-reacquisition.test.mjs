import assert from "node:assert/strict";
import test from "node:test";

class FakeAdaptive {
  constructor(settings = {}) {
    this.settings = { maximumMissedFrames: 14, ...settings };
    this.reset();
    this.queue = [];
  }

  reset() {
    this.previous = null;
    this.pending = null;
    this.missedFrames = 0;
    this.position = { x: 0, y: 0 };
    this.smoothed = { x: 0, y: 0 };
    this.velocity = { x: 0, y: -500 };
    this.previousTime = 0;
    this.sourceWidth = 1080;
    this.sourceHeight = 1920;
  }

  initialize(input) {
    this.sourceWidth = input.sourceWidth;
    this.sourceHeight = input.sourceHeight;
    this.position = { x: input.x, y: input.y };
    this.smoothed = { ...this.position };
    this.velocity = { ...input.velocity };
    this.previousTime = input.time;
    this.startedAt = input.time;
  }

  predict(time) {
    const dt = Math.max(1 / 300, time - this.previousTime);
    return {
      x: this.position.x + this.velocity.x * dt,
      y: this.position.y + this.velocity.y * dt,
      dt,
    };
  }

  track(input) {
    const raw = this.queue.shift();
    if (!raw) throw new Error("Missing fake adaptive point.");
    const dt = Math.max(1 / 300, input.time - this.previousTime);
    if (raw.state === "DETECTED") {
      const old = { ...this.position };
      this.position = { x: raw.x, y: raw.y };
      this.smoothed = { ...this.position };
      this.velocity = { x: (raw.x - old.x) / dt, y: (raw.y - old.y) / dt };
      this.missedFrames = 0;
    } else {
      const predicted = this.predict(input.time);
      this.position = { x: predicted.x, y: predicted.y };
      this.smoothed = { ...this.position };
      this.missedFrames += 1;
    }
    this.previousTime = input.time;
    this.previous = {
      frame: new Uint8ClampedArray(input.frame),
      width: input.width,
      height: input.height,
      originX: input.originX,
      originY: input.originY,
    };
    const score = raw.score ?? raw.confidence ?? 0.7;
    return {
      ...raw,
      smoothX: raw.x,
      smoothY: raw.y,
      sourceX: raw.x,
      sourceY: raw.y,
      time: input.time,
      candidateScore: score,
      confidence: score,
      launched: true,
      adaptive: true,
    };
  }
}

globalThis.BallTraceAdaptive = Object.freeze({ AdaptiveSourceTracker: FakeAdaptive });
globalThis.BallTraceTrajectory = Object.freeze({
  buildPredictedTrajectory({ points }) { return points; },
});
await import("../strict-reacquisition.js");

const Tracker = globalThis.BallTraceAdaptive.AdaptiveSourceTracker;
const frame = new Uint8ClampedArray(16);
const input = (time) => ({ frame, width: 2, height: 2, originX: 0, originY: 0, time, fps: 30 });

function initialize(tracker) {
  tracker.initialize({
    sourceWidth: 1080,
    sourceHeight: 1920,
    x: 500,
    y: 1500,
    time: 0,
    velocity: { x: -200, y: -800 },
  });
}

test("continuous plausible flight remains detected", () => {
  const tracker = new Tracker();
  initialize(tracker);
  tracker.queue.push(
    { state: "DETECTED", x: 493, y: 1473, score: 0.8 },
    { state: "DETECTED", x: 486, y: 1446, score: 0.8 },
  );
  assert.equal(tracker.track(input(1 / 30)).state, "DETECTED");
  assert.equal(tracker.track(input(2 / 30)).state, "DETECTED");
});

test("reacquisition needs three consecutive plausible frames", () => {
  const tracker = new Tracker();
  initialize(tracker);
  tracker.queue.push(
    { state: "DETECTED", x: 493, y: 1473, score: 0.8 },
    { state: "PREDICTED", x: 486, y: 1446, score: 0.2 },
    { state: "DETECTED", x: 479, y: 1419, score: 0.62 },
    { state: "DETECTED", x: 472, y: 1392, score: 0.63 },
    { state: "DETECTED", x: 465, y: 1365, score: 0.64 },
  );
  assert.equal(tracker.track(input(1 / 30)).state, "DETECTED");
  assert.equal(tracker.track(input(2 / 30)).state, "PREDICTED");
  const first = tracker.track(input(3 / 30));
  const second = tracker.track(input(4 / 30));
  const third = tracker.track(input(5 / 30));
  assert.equal(first.state, "PREDICTED");
  assert.equal(first.provisionalReacquisition, true);
  assert.equal(second.state, "PREDICTED");
  assert.equal(second.provisionalReacquisition, true);
  assert.equal(third.state, "DETECTED");
  assert.equal(third.reacquisitionConfirmed, true);
  assert.equal(third.confirmationFrames, 3);
});

test("flat sand candidates cannot become a real reacquisition", () => {
  const tracker = new Tracker();
  initialize(tracker);
  tracker.queue.push(
    { state: "DETECTED", x: 493, y: 1473, score: 0.8 },
    { state: "PREDICTED", x: 486, y: 1446, score: 0.2 },
    { state: "DETECTED", x: 430, y: 1470, score: 0.8 },
    { state: "DETECTED", x: 390, y: 1472, score: 0.8 },
    { state: "DETECTED", x: 350, y: 1474, score: 0.8 },
  );
  tracker.track(input(1 / 30));
  tracker.track(input(2 / 30));
  for (const time of [3 / 30, 4 / 30, 5 / 30]) {
    assert.notEqual(tracker.track(input(time)).state, "DETECTED");
  }
});

test("trajectory lock drops early horizontal dog-leg points", () => {
  const points = [
    { state: "DETECTED", x: 500, y: 500, smoothX: 500, smoothY: 500, time: 0 },
    { state: "DETECTED", x: 480, y: 450, smoothX: 480, smoothY: 450, time: 0.03 },
    { state: "DETECTED", x: 455, y: 395, smoothX: 455, smoothY: 395, time: 0.06 },
    { state: "DETECTED", x: 390, y: 398, smoothX: 390, smoothY: 398, time: 0.09, reacquisitionConfirmed: true },
    { state: "DETECTED", x: 330, y: 400, smoothX: 330, smoothY: 400, time: 0.12, reacquisitionConfirmed: true },
  ];
  const filtered = globalThis.BallTraceAdaptive.flightLockedPoints(points);
  assert.equal(filtered.length, 3);
  assert.ok(!filtered.some((point) => point.x === 390 || point.x === 330));
});
