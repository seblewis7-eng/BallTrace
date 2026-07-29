(function attachBallTraceCore(root) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    sampleRadius: 3,
    preLaunchSearchRadius: 72,
    launchedSearchRadiusMin: 52,
    launchedSearchRadiusMax: 220,
    detectedThreshold: 0.58,
    reacquireThreshold: 0.64,
    maxPredictedGapFrames: 3,
    launchSpeedPxPerSecond: 95,
    launchDistancePx: 7,
    smoothingAlpha: 0.62,
    minBrightness: 0.42,
    gridStep: 2,
  });

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function rgbToHsv(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
      if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
      else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
      else h = 60 * ((rn - gn) / delta + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : delta / max, v: max };
  }

  function luminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function circularHueDistance(a, b) {
    const diff = Math.abs(a - b) % 360;
    return Math.min(diff, 360 - diff) / 180;
  }

  function classifyColour(r, g, b) {
    const hsv = rgbToHsv(r, g, b);
    const white = hsv.v > 0.58 && hsv.s < 0.35;
    const yellow = hsv.v > 0.48 && hsv.s > 0.28 && hsv.h >= 32 && hsv.h <= 78;
    return white ? "white" : yellow ? "yellow" : "other";
  }

  function samplePatch(frame, width, height, x, y, radius = 4) {
    const minX = clamp(Math.floor(x - radius), 0, width - 1);
    const maxX = clamp(Math.ceil(x + radius), 0, width - 1);
    const minY = clamp(Math.floor(y - radius), 0, height - 1);
    const maxY = clamp(Math.ceil(y + radius), 0, height - 1);
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const index = (py * width + px) * 4;
        r += frame[index];
        g += frame[index + 1];
        b += frame[index + 2];
        count += 1;
      }
    }
    const colour = { r: r / count, g: g / count, b: b / count };
    const hsv = rgbToHsv(colour.r, colour.g, colour.b);
    return { ...colour, ...hsv, luminance: luminance(colour.r, colour.g, colour.b), className: classifyColour(colour.r, colour.g, colour.b) };
  }

  function colourSimilarity(sample, template) {
    const sampleHsv = rgbToHsv(sample.r, sample.g, sample.b);
    const templateHsv = rgbToHsv(template.r, template.g, template.b);
    const rgbDistance = Math.hypot(sample.r - template.r, sample.g - template.g, sample.b - template.b) / 441.673;
    const hueDistance = circularHueDistance(sampleHsv.h, templateHsv.h);
    const saturationDistance = Math.abs(sampleHsv.s - templateHsv.s);
    const valueDistance = Math.abs(sampleHsv.v - templateHsv.v);
    const hueWeight = templateHsv.s > 0.2 ? 0.34 : 0.08;
    const score = 1 - (rgbDistance * 0.45 + hueDistance * hueWeight + saturationDistance * 0.17 + valueDistance * (0.38 - hueWeight));
    const sampleClass = classifyColour(sample.r, sample.g, sample.b);
    const templateClass = classifyColour(template.r, template.g, template.b);
    return clamp(score * (sampleClass === templateClass ? 1 : 0.72), 0, 1);
  }

  function patchStats(frame, previousFrame, width, height, x, y, radius) {
    const minX = clamp(x - radius, 0, width - 1);
    const maxX = clamp(x + radius, 0, width - 1);
    const minY = clamp(y - radius, 0, height - 1);
    const maxY = clamp(y + radius, 0, height - 1);
    let r = 0;
    let g = 0;
    let b = 0;
    let motion = 0;
    let centreLum = 0;
    let edgeLum = 0;
    let centreCount = 0;
    let edgeCount = 0;
    let count = 0;
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const index = (py * width + px) * 4;
        const pr = frame[index];
        const pg = frame[index + 1];
        const pb = frame[index + 2];
        const lum = luminance(pr, pg, pb);
        r += pr; g += pg; b += pb; count += 1;
        const dx = Math.abs(px - x);
        const dy = Math.abs(py - y);
        if (dx <= 1 && dy <= 1) { centreLum += lum; centreCount += 1; }
        else if (dx === radius || dy === radius) { edgeLum += lum; edgeCount += 1; }
        if (previousFrame) {
          motion += (Math.abs(pr - previousFrame[index]) + Math.abs(pg - previousFrame[index + 1]) + Math.abs(pb - previousFrame[index + 2])) / (255 * 3);
        }
      }
    }
    return {
      r: r / count,
      g: g / count,
      b: b / count,
      motion: previousFrame ? motion / count : 0,
      contrast: clamp(Math.abs((centreLum / Math.max(1, centreCount)) - (edgeLum / Math.max(1, edgeCount))) * 2.2, 0, 1),
    };
  }

  function findBestCandidate({ frame, previousFrame, width, height, predicted, searchRadius, template, settings }) {
    const radius = settings.sampleRadius;
    const step = settings.gridStep;
    const minX = clamp(Math.floor(predicted.x - searchRadius), radius, width - radius - 1);
    const maxX = clamp(Math.ceil(predicted.x + searchRadius), radius, width - radius - 1);
    const minY = clamp(Math.floor(predicted.y - searchRadius), radius, height - radius - 1);
    const maxY = clamp(Math.ceil(predicted.y + searchRadius), radius, height - radius - 1);
    let best = null;
    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        const dist = Math.hypot(x - predicted.x, y - predicted.y);
        if (dist > searchRadius) continue;
        const centreIndex = (y * width + x) * 4;
        const cr = frame[centreIndex];
        const cg = frame[centreIndex + 1];
        const cb = frame[centreIndex + 2];
        const centreClass = classifyColour(cr, cg, cb);
        const centreLum = luminance(cr, cg, cb);
        if (centreClass === "other" && centreLum < settings.minBrightness) continue;
        const stats = patchStats(frame, previousFrame, width, height, x, y, radius);
        const colour = colourSimilarity(stats, template);
        const classMatch = classifyColour(stats.r, stats.g, stats.b) === template.className ? 1 : 0;
        const motion = clamp(stats.motion * 3.2, 0, 1);
        const proximity = Math.exp(-2.4 * (dist / Math.max(1, searchRadius)) ** 2);
        const brightness = clamp(luminance(stats.r, stats.g, stats.b) / Math.max(0.35, template.luminance), 0, 1);
        const score = colour * 0.38 + proximity * 0.24 + motion * 0.18 + stats.contrast * 0.1 + brightness * 0.06 + classMatch * 0.04;
        if (!best || score > best.score) best = { x, y, score, colour, motion, proximity, contrast: stats.contrast };
      }
    }
    return best;
  }

  class Tracker {
    constructor(settings = {}) { this.settings = { ...DEFAULT_SETTINGS, ...settings }; this.reset(); }
    reset() {
      this.initialized = false;
      this.previousFrame = null;
      this.position = null;
      this.smoothed = null;
      this.velocity = { x: 0, y: 0 };
      this.template = null;
      this.startedAt = 0;
      this.previousTime = 0;
      this.missedFrames = 0;
      this.launched = false;
      this.initialPosition = null;
    }
    initialize({ frame, width, height, x, y, time = 0, template = null }) {
      this.width = width;
      this.height = height;
      this.position = { x, y };
      this.smoothed = { x, y };
      this.initialPosition = { x, y };
      this.template = template || samplePatch(frame, width, height, x, y, 5);
      this.previousFrame = new Uint8ClampedArray(frame);
      this.startedAt = time;
      this.previousTime = time;
      this.missedFrames = 0;
      this.launched = false;
      this.initialized = true;
      return { state: "DETECTED", x, y, smoothX: x, smoothY: y, confidence: 1, time, searchRadius: this.settings.preLaunchSearchRadius };
    }
    track({ frame, time }) {
      if (!this.initialized) throw new Error("Tracker must be initialized before track().");
      const dt = clamp(time - this.previousTime, 1 / 240, 0.25);
      const predicted = { x: clamp(this.position.x + this.velocity.x * dt, 0, this.width - 1), y: clamp(this.position.y + this.velocity.y * dt, 0, this.height - 1) };
      const speed = Math.hypot(this.velocity.x, this.velocity.y);
      const searchRadius = this.launched ? clamp(speed * dt * 2.5 + 42, this.settings.launchedSearchRadiusMin, this.settings.launchedSearchRadiusMax) : this.settings.preLaunchSearchRadius;
      const candidate = findBestCandidate({ frame, previousFrame: this.previousFrame, width: this.width, height: this.height, predicted, searchRadius, template: this.template, settings: this.settings });
      const threshold = this.missedFrames > 0 ? this.settings.reacquireThreshold : this.settings.detectedThreshold;
      let state;
      let confidence;
      let nextPosition;
      if (candidate && candidate.score >= threshold) {
        state = "DETECTED";
        confidence = candidate.score;
        nextPosition = { x: candidate.x, y: candidate.y };
        const measuredVelocity = { x: (nextPosition.x - this.position.x) / dt, y: (nextPosition.y - this.position.y) / dt };
        const blend = this.launched ? 0.72 : 0.48;
        this.velocity = { x: this.velocity.x * (1 - blend) + measuredVelocity.x * blend, y: this.velocity.y * (1 - blend) + measuredVelocity.y * blend };
        this.missedFrames = 0;
      } else if (this.missedFrames < this.settings.maxPredictedGapFrames) {
        state = "PREDICTED";
        confidence = Math.max(0.05, (candidate?.score || 0) * 0.65);
        nextPosition = predicted;
        this.velocity.x *= 0.94;
        this.velocity.y *= 0.94;
        this.missedFrames += 1;
      } else {
        state = "LOST";
        confidence = candidate?.score || 0;
        nextPosition = predicted;
        this.previousFrame = new Uint8ClampedArray(frame);
        this.previousTime = time;
        return { state, x: nextPosition.x, y: nextPosition.y, smoothX: this.smoothed.x, smoothY: this.smoothed.y, confidence, time, searchRadius };
      }
      this.position = nextPosition;
      const alpha = this.settings.smoothingAlpha;
      this.smoothed = { x: this.smoothed.x * (1 - alpha) + nextPosition.x * alpha, y: this.smoothed.y * (1 - alpha) + nextPosition.y * alpha };
      const distanceFromStart = distance(this.position, this.initialPosition);
      const currentSpeed = Math.hypot(this.velocity.x, this.velocity.y);
      if (!this.launched && (currentSpeed >= this.settings.launchSpeedPxPerSecond || distanceFromStart >= this.settings.launchDistancePx)) this.launched = true;
      this.previousFrame = new Uint8ClampedArray(frame);
      this.previousTime = time;
      return { state, x: nextPosition.x, y: nextPosition.y, smoothX: this.smoothed.x, smoothY: this.smoothed.y, confidence, time, searchRadius };
    }
  }

  root.BallTraceCore = Object.freeze({ DEFAULT_SETTINGS, Tracker, classifyColour, colourSimilarity, findBestCandidate, luminance, rgbToHsv, samplePatch });
})(typeof self !== "undefined" ? self : globalThis);
