import assert from "node:assert/strict";
import test from "node:test";
await import("../trajectory.js");
const { buildPredictedTrajectory, estimateMotion } = globalThis.BallTraceTrajectory;

function detected(time, x, y) {
  return { state: "DETECTED", time, x, y, smoothX: x, smoothY: y, confidence: 0.8 };
}

const risingFlight = [
  detected(1.00, 430, 760),
  detected(1.03, 420, 700),
  detected(1.07, 408, 635),
  detected(1.10, 395, 575),
  detected(1.13, 382, 520),
  detected(1.17, 370, 474),
  detected(1.20, 359, 435),
];

test("estimates motion only from genuine detections", () => {
  const mixed = [...risingFlight, { state: "LOST", time: 1.23, x: 0, y: 0 }];
  const motion = estimateMotion(mixed, 506, 900);
  assert.ok(motion);
  assert.equal(motion.last.time, 1.2);
  assert.ok(motion.vy < 0);
});

test("continues upward before producing a descent", () => {
  const prediction = buildPredictedTrajectory({
    points: risingFlight,
    width: 506,
    height: 900,
    videoEndTime: 8,
  });
  assert.ok(prediction.length > 30);
  const ys = prediction.map((point) => point.y);
  const minimum = Math.min(...ys);
  const minimumIndex = ys.indexOf(minimum);
  assert.ok(minimumIndex > 2, "prediction should continue rising before apex");
  assert.ok(minimumIndex < ys.length - 2, "prediction should descend after apex");
  assert.ok(prediction.at(-1).y > minimum);
});

test("preserves the observed sideways direction", () => {
  const prediction = buildPredictedTrajectory({
    points: risingFlight,
    width: 506,
    height: 900,
    videoEndTime: 8,
  });
  assert.ok(prediction.at(-1).x < risingFlight.at(-1).x);
});

test("caps the estimate to the available source video", () => {
  const prediction = buildPredictedTrajectory({
    points: risingFlight,
    width: 506,
    height: 900,
    videoEndTime: 1.7,
  });
  assert.ok(prediction.length > 2);
  assert.ok(prediction.at(-1).time <= 1.700001);
});

test("does not invent a trajectory from too little movement", () => {
  const prediction = buildPredictedTrajectory({
    points: [detected(1, 100, 100), detected(1.03, 101, 100), detected(1.07, 101, 99)],
    width: 506,
    height: 900,
    videoEndTime: 8,
  });
  assert.deepEqual(prediction, []);
});

test("estimated confidence fades over the continuation", () => {
  const prediction = buildPredictedTrajectory({
    points: risingFlight,
    width: 506,
    height: 900,
    videoEndTime: 8,
  });
  assert.ok(prediction[0].confidence > prediction.at(-1).confidence);
  assert.ok(prediction.every((point) => point.state === "ESTIMATED" && point.estimated));
});
