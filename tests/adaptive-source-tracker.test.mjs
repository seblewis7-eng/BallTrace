import assert from "node:assert/strict";
import test from "node:test";

await import("../tracker-core.js");
await import("../adaptive-source-tracker.js");

const { AdaptiveSourceTracker, FrameRateEstimator } = globalThis.BallTraceAdaptive;

function makeCrop(width, height, originX, originY, ball, distractor = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 70;
    data[index + 1] = 120;
    data[index + 2] = 170;
    data[index + 3] = 255;
  }
  for (const object of [ball, distractor]) {
    if (!object) continue;
    const localX = Math.round(object.x - originX);
    const localY = Math.round(object.y - originY);
    const radius = object.radius || 2;
    for (let y = localY - radius; y <= localY + radius; y += 1) {
      for (let x = localX - radius; x <= localX + radius; x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height || Math.hypot(x - localX, y - localY) > radius) continue;
        const index = (y * width + x) * 4;
        data[index] = 245;
        data[index + 1] = 220;
        data[index + 2] = 35;
      }
    }
  }
  return data;
}

test("estimates actual 120 fps decoded timing", () => {
  const estimator = new FrameRateEstimator(30);
  for (let index = 0; index < 18; index += 1) estimator.add(index / 120);
  assert.ok(estimator.fps > 115 && estimator.fps < 125);
  assert.ok(Math.abs(estimator.frameDuration - 1 / 120) < 0.0002);
});

test("tracks a shrinking one-pixel yellow ball in a moving source crop", () => {
  const tracker = new AdaptiveSourceTracker({ maximumMissedFrames: 8 });
  tracker.initialize({
    sourceWidth: 1080,
    sourceHeight: 1920,
    x: 180,
    y: 1500,
    time: 0,
    template: { r: 245, g: 220, b: 35, className: "yellow", luminance: 0.8 },
    velocity: { x: 250, y: -900 },
    initialRadius: 4,
  });

  let detected = 0;
  for (let index = 1; index <= 14; index += 1) {
    const time = index / 120;
    const ball = {
      x: 180 + 250 * time,
      y: 1500 - 900 * time,
      radius: Math.max(1, 4 - Math.floor(index / 4)),
    };
    const specification = tracker.nextCrop(time, 120);
    const originX = Math.max(0, Math.round(specification.centerX - specification.halfSize));
    const originY = Math.max(0, Math.round(specification.centerY - specification.halfSize));
    const width = Math.min(1080 - originX, specification.halfSize * 2);
    const height = Math.min(1920 - originY, specification.halfSize * 2);
    const distractor = index > 5 ? { x: ball.x + 90, y: ball.y + 80, radius: 3 } : null;
    const point = tracker.track({
      frame: makeCrop(width, height, originX, originY, ball, distractor),
      width,
      height,
      originX,
      originY,
      time,
      fps: 120,
    });
    if (point.state === "DETECTED") detected += 1;
  }
  assert.ok(detected >= 8, `only ${detected} frames were detected`);
});

test("uses a smaller crop at 120 fps than at 30 fps for the same motion", () => {
  const input = {
    sourceWidth: 1080,
    sourceHeight: 1920,
    x: 300,
    y: 1400,
    time: 0,
    template: { r: 245, g: 220, b: 35, className: "yellow", luminance: 0.8 },
    velocity: { x: 300, y: -900 },
    initialRadius: 4,
  };
  const slow = new AdaptiveSourceTracker();
  const fast = new AdaptiveSourceTracker();
  slow.initialize(input);
  fast.initialize(input);
  assert.ok(fast.nextCrop(1 / 120, 120).halfSize < slow.nextCrop(1 / 30, 30).halfSize);
});
