"use strict";

importScripts("./tracker-core.js", "./tracking-guard.js");
let tracker = null;
self.addEventListener("message", (event) => {
  try {
    const message = event.data;
    if (message.type === "init") {
      tracker = new self.BallTraceCore.Tracker(message.settings);
      const point = tracker.initialize({ frame: new Uint8ClampedArray(message.frame), width: message.width, height: message.height, x: message.x, y: message.y, time: message.time, template: message.template });
      self.postMessage({ type: "point", point });
      return;
    }
    if (message.type === "frame") {
      if (!tracker) throw new Error("Tracker worker has not been initialized.");
      const point = tracker.track({ frame: new Uint8ClampedArray(message.frame), time: message.time });
      self.postMessage({ type: "point", point });
      return;
    }
    if (message.type === "reset") { tracker = null; self.postMessage({ type: "reset-complete" }); }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
