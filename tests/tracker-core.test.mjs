import test from "node:test";
import assert from "node:assert/strict";
await import("../tracker-core.js");
const { Tracker, classifyColour, colourSimilarity, samplePatch } = globalThis.BallTraceCore;

function frame(width, height, ball = null, background = [32, 90, 46], radius = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = background[0];
    data[index + 1] = background[1];
    data[index + 2] = background[2];
    data[index + 3] = 255;
  }
  if (ball) drawDisc(data, width, height, ball.x, ball.y, radius, ball.colour);
  return data;
}

function setPixel(data, width, x, y, colour) {
  const index = (y * width + x) * 4;
  data[index] = colour[0];
  data[index + 1] = colour[1];
  data[index + 2] = colour[2];
  data[index + 3] = 255;
}

function drawDisc(data, width, height, x, y, radius, colour) {
  for (let py = Math.max(0, y - radius); py <= Math.min(height - 1, y + radius); py += 1) {
    for (let px = Math.max(0, x - radius); px <= Math.min(width - 1, x + radius); px += 1) {
      if (Math.hypot(px - x, py - y) <= radius) setPixel(data, width, px, py, colour);
    }
  }
  return data;
}

function drawRect(data, width, height, x, y, rectWidth, rectHeight, colour) {
  for (let py = Math.max(0, y); py < Math.min(height, y + rectHeight); py += 1) {
    for (let px = Math.max(0, x); px < Math.min(width, x + rectWidth); px += 1) {
      setPixel(data, width, px, py, colour);
    }
  }
  return data;
}

test("classifies white and yellow balls", () => {
  assert.equal(classifyColour(240, 242, 238), "white");
  assert.equal(classifyColour(245, 220, 35), "yellow");
});

test("colour similarity favours the selected ball colour", () => {
  const template = { r: 245, g: 220, b: 35, className: "yellow" };
  assert.ok(colourSimilarity({ r: 240, g: 215, b: 40 }, template) > colourSimilarity({ r: 235, g: 235, b: 235 }, template));
});

test("selected yellow template ignores surrounding green mat and blue clubhead", () => {
  const width = 100;
  const height = 80;
  const data = frame(width, height, null, [35, 72, 51]);
  drawDisc(data, width, height, 50, 50, 4, [231, 220, 72]);
  drawRect(data, width, height, 54, 45, 22, 12, [55, 93, 142]);
  const template = samplePatch(data, width, height, 50, 50, 8);
  assert.equal(template.className, "yellow");
  assert.ok(template.r > 190);
  assert.ok(template.g > 180);
  assert.ok(template.b < 120);
});

test("tracks a small 30 fps yellow-ball sequence", () => {
  const width = 506;
  const height = 900;
  const tracker = new Tracker();
  const colour = [235, 222, 70];
  tracker.initialize({ frame: frame(width, height, { x: 420, y: 720, colour }, [35, 72, 51], 3), width, height, x: 420, y: 720, time: 0 });
  const points = [{ x: 420, y: 720 }, { x: 418, y: 716 }, { x: 330, y: 610 }, { x: 238, y: 520 }, { x: 155, y: 450 }];
  let result;
  for (let index = 1; index < points.length; index += 1) {
    result = tracker.track({ frame: frame(width, height, { ...points[index], colour }, [35, 72, 51], 3), time: index / 30 });
    assert.notEqual(result.state, "LOST", `lost at frame ${index}`);
  }
  assert.equal(result.launched, true);
  assert.ok(Math.abs(result.x - 155) < 16);
  assert.ok(Math.abs(result.y - 450) < 16);
});

test("wide launch search handles a large first-frame jump at 30 fps", () => {
  const width = 506;
  const height = 900;
  const tracker = new Tracker();
  const colour = [242, 242, 238];
  tracker.initialize({ frame: frame(width, height, { x: 420, y: 720, colour }, [35, 72, 51], 3), width, height, x: 420, y: 720, time: 1 });
  const result = tracker.track({ frame: frame(width, height, { x: 230, y: 520, colour }, [35, 72, 51], 3), time: 1 + 1 / 30 });
  assert.equal(result.state, "DETECTED");
  assert.equal(result.launched, true);
  assert.ok(Math.abs(result.x - 230) < 18);
  assert.ok(Math.abs(result.y - 520) < 18);
});

test("compact white ball beats a larger moving white club shape", () => {
  const width = 420;
  const height = 280;
  const background = [33, 77, 48];
  const colour = [242, 242, 238];
  const initial = frame(width, height, { x: 80, y: 220, colour }, background, 4);
  const next = frame(width, height, null, background);
  drawDisc(next, width, height, 235, 125, 4, colour);
  drawRect(next, width, height, 125, 160, 42, 16, colour);
  const tracker = new Tracker();
  tracker.initialize({ frame: initial, width, height, x: 80, y: 220, time: 0 });
  const result = tracker.track({ frame: next, time: 1 / 30 });
  assert.equal(result.state, "DETECTED");
  assert.ok(Math.abs(result.x - 235) < 18, `tracked x=${result.x}`);
  assert.ok(Math.abs(result.y - 125) < 18, `tracked y=${result.y}`);
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
