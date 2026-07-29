import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const core = await readFile(new URL("../tracker-core.js", import.meta.url), "utf8");

test("tracks actual decoded video frames when supported", () => {
  assert.match(app, /requestVideoFrameCallback/);
  assert.match(app, /trackPresentedFrames/);
  assert.match(app, /metadata\.mediaTime/);
});

test("does not guess a 60 fps launch timeline", () => {
  assert.doesNotMatch(app, /1\s*\/\s*60/);
  assert.match(app, /1\s*\/\s*30/);
});

test("uses higher analysis resolution for 1080p clips", () => {
  assert.match(app, /900\s*\/\s*Math\.max/);
});

test("tracker includes a wide first-launch search", () => {
  assert.match(core, /launchSearchRadius:\s*260/);
  assert.match(core, /mode:\s*"launch"/);
  assert.match(core, /wideGridStep/);
});
