import test from "node:test";
import assert from "node:assert/strict";
await import("../tracker-core.js");
const { Tracker, classifyColour, colourSimilarity } = globalThis.BallTraceCore;

function frame(width, height, ball = null, background = [32, 90, 46], radius = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = background[0];
    data[index + 1] = background[1];
    data[index + 2] = background[2];
    data[index + 3] = 255;
  }
  if (!ball) return data;
  for (let y = Math.max(0, ball.y - radius); y <= Math.min(height - 1, ball.y + radius); y += 1) {
    for (let x = Math.max(0, ball.x - radius); x <= Math.min(width - 1, ball.x + radius); x += 1) {
      if (Math.hypot(x - ball.x, y - ball.y) > radius) continue;
      const index = (y * width + x) * 4;
      data[index] = ball.colour[0];
      data[index + 1] = ball.colour[1];
      data[index + 2] = ball.colour[2];
    }
  }
  return data;
}

test("classifies white and yellow balls", () => {
  assert.equal(classifyColour(240, 242, 238), "white");
  assert.equal(classifyColour(245, 220, 35), "yellow");
});

test("colour similarity favours the selected ball colour", () => {
  const template = { r: 245, g: 220, b: 35 };
  assert.ok(colourSimilarity({ r: 240, g: 215, b: 40 }, template) > colourSimilarity({ r: 235, g: 235, b: 235 }, template));
});

test("tracks an ordinary 30 fps yellow-ball sequence", () => {
  const width = 360;
  const height = 220;
  const tracker = new Tracker();
  const colour = [245, 220, 35];
  tracker.initialize({ frame: frame(width, height, { x: 70, y: 170, colour }), width, height, x: 70, y: 170, time: 0 });
  const points = [{ x: 70, y: 170 }, { x: 72, y: 168 }, { x: 128, y: 130 }, { x: 186, y: 99 }, { x: 244, y: 75 }];
  let result;
  for (let index = 1; index < points.length; index += 1) {
    result = tracker.track({ frame: frame(width, height, { ...points[index], colour }), time: index / 30 });
    assert.notEqual(result.state, "LOST", `lost at frame ${index}`);
  }
  assert.equal(result.launched, true);
  assert.ok(Math.abs(result.x - 244) < 12);
  assert.ok(Math.abs(result.y - 75) < 12);
});

test("wide launch search handles a large first-frame jump at 30 fps", () => {
  const width = 420;
  const height = 260;
  const tracker = new Tracker();
  const colour = [242, 242, 238];
  tracker.initialize({ frame: frame(width, height, { x: 85, y: 205, colour }), width, height, x: 85, y: 205, time: 1 });
  const result = tracker.track({ frame: frame(width, height, { x: 225, y: 125, colour }), time: 1 + 1 / 30 });
  assert.equal(result.state, "DETECTED");
  assert.equal(result.launched, true);
  assert.ok(Math.abs(result.x - 225) < 15);
});

test("duplicate decoded frames do not immediately lose the ball", () => {
  const width = 260;
  const height = 180;
  const tracker = new Tracker();
  const colour = [245, 220, 35];
  const still = frame(width, height, { x: 80, y: 130, colour });
  tracker.initialize({ frame: still, width, height, x: 80, y: 130, time: 0 });
  for (let index = 1; index <= 4; index += 1) {
    const result = tracker.track({ frame: still, time: index / 60 });
    assert.notEqual(result.state, "LOST");
  }
});

test("predicts short gaps and reacquires the ball", () => {
  const width = 320;
  const height = 200;
  const tracker = new Tracker();
  const colour = [245, 220, 35];
  tracker.initialize({ frame: frame(width, height, { x: 60, y: 150, colour }), width, height, x: 60, y: 150, time: 0 });
  tracker.track({ frame: frame(width, height, { x: 100, y: 125, colour }), time: 1 / 30 });
  const predicted = tracker.track({ frame: frame(width, height), time: 2 / 30 });
  assert.equal(predicted.state, "PREDICTED");
  const reacquired = tracker.track({ frame: frame(width, height, { x: 178, y: 82, colour }), time: 3 / 30 });
  assert.equal(reacquired.state, "DETECTED");
});
