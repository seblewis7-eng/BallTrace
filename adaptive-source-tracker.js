(function attachBallTraceAdaptive(root) {
  "use strict";

  const core = root.BallTraceCore;
  if (!core) throw new Error("BallTraceCore must load before adaptive-source-tracker.js");

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  class FrameRateEstimator {
    constructor(fallbackFps = 30) {
      this.fallbackFps = clamp(fallbackFps, 12, 240);
      this.samples = [];
      this.lastTime = null;
    }

    reset(time = null) {
      this.samples = [];
      this.lastTime = Number.isFinite(time) ? time : null;
    }

    add(mediaTime) {
      if (!Number.isFinite(mediaTime)) return this.fps;
      if (this.lastTime != null) {
        const delta = mediaTime - this.lastTime;
        if (delta >= 1 / 300 && delta <= 1 / 8) {
          this.samples.push(delta);
          if (this.samples.length > 24) this.samples.shift();
        }
      }
      this.lastTime = mediaTime;
      return this.fps;
    }

    get frameDuration() {
      const value = median(this.samples);
      return value > 0 ? value : 1 / this.fallbackFps;
    }

    get fps() {
      return clamp(1 / this.frameDuration, 12, 240);
    }
  }

  function estimateInitialRadius(frame, width, height, x, y, className, maximum = 10) {
    const matches = (px, py) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return false;
      const index = (py * width + px) * 4;
      return core.classifyColour(frame[index], frame[index + 1], frame[index + 2]) === className;
    };
    let radius = 1;
    for (let candidate = 1; candidate <= maximum; candidate += 1) {
      let hits = 0;
      let count = 0;
      const steps = Math.max(8, candidate * 8);
      for (let index = 0; index < steps; index += 1) {
        const angle = index / steps * Math.PI * 2;
        const px = Math.round(x + Math.cos(angle) * candidate);
        const py = Math.round(y + Math.sin(angle) * candidate);
        hits += matches(px, py) ? 1 : 0;
        count += 1;
      }
      if (hits / Math.max(1, count) < 0.34) break;
      radius = candidate;
    }
    return clamp(radius, 1, maximum);
  }

  function previousPixel(previous, globalX, globalY) {
    if (!previous) return null;
    const x = Math.round(globalX - previous.originX);
    const y = Math.round(globalY - previous.originY);
    if (x < 0 || y < 0 || x >= previous.width || y >= previous.height) return null;
    const index = (y * previous.width + x) * 4;
    return [previous.frame[index], previous.frame[index + 1], previous.frame[index + 2]];
  }

  function patchScore({ frame, width, height, x, y, radius, template, previous, originX, originY }) {
    let similarity = 0;
    let motion = 0;
    let centreLuminance = 0;
    let outerLuminance = 0;
    let innerCount = 0;
    let outerCount = 0;
    let classMatches = 0;
    const innerRadius = Math.max(1, Math.round(radius));
    const outerRadius = innerRadius + 2;

    for (let py = Math.max(0, y - outerRadius); py <= Math.min(height - 1, y + outerRadius); py += 1) {
      for (let px = Math.max(0, x - outerRadius); px <= Math.min(width - 1, x + outerRadius); px += 1) {
        const distance = Math.hypot(px - x, py - y);
        if (distance > outerRadius) continue;
        const index = (py * width + px) * 4;
        const sample = { r: frame[index], g: frame[index + 1], b: frame[index + 2] };
        const lum = core.luminance(sample.r, sample.g, sample.b);
        if (distance <= innerRadius) {
          similarity += core.colourSimilarity(sample, template);
          centreLuminance += lum;
          innerCount += 1;
          if (core.classifyColour(sample.r, sample.g, sample.b) === template.className) classMatches += 1;
          const prior = previousPixel(previous, originX + px, originY + py);
          if (prior) {
            motion += (Math.abs(sample.r - prior[0]) + Math.abs(sample.g - prior[1]) + Math.abs(sample.b - prior[2])) / (255 * 3);
          }
        } else {
          outerLuminance += lum;
          outerCount += 1;
        }
      }
    }

    const meanSimilarity = similarity / Math.max(1, innerCount);
    const meanMotion = motion / Math.max(1, innerCount);
    const contrast = clamp(Math.abs(
      centreLuminance / Math.max(1, innerCount) - outerLuminance / Math.max(1, outerCount)
    ) * 2.4, 0, 1);
    const classFraction = classMatches / Math.max(1, innerCount);
    return { meanSimilarity, meanMotion, contrast, classFraction };
  }

  function candidateAllowed(sample, template, motion) {
    const hsv = core.rgbToHsv(sample.r, sample.g, sample.b);
    const className = core.classifyColour(sample.r, sample.g, sample.b);
    const similarity = core.colourSimilarity(sample, template);
    if (template.className === "yellow") {
      return className === "yellow"
        || similarity >= 0.58
        || (motion >= 0.13 && hsv.h >= 18 && hsv.h <= 105 && hsv.v >= 0.25);
    }
    if (template.className === "white") {
      return className === "white"
        || similarity >= 0.6
        || (motion >= 0.13 && hsv.s <= 0.58 && hsv.v >= 0.33);
    }
    return similarity >= 0.62 || motion >= 0.18;
  }

  function findAdaptiveCandidate({
    frame,
    width,
    height,
    originX,
    originY,
    predicted,
    template,
    expectedRadius,
    previous,
    searchRadius,
  }) {
    const predictedLocal = { x: predicted.x - originX, y: predicted.y - originY };
    const step = expectedRadius <= 1.8 ? 1 : 2;
    let best = null;
    const minX = Math.max(1, Math.floor(predictedLocal.x - searchRadius));
    const maxX = Math.min(width - 2, Math.ceil(predictedLocal.x + searchRadius));
    const minY = Math.max(1, Math.floor(predictedLocal.y - searchRadius));
    const maxY = Math.min(height - 2, Math.ceil(predictedLocal.y + searchRadius));

    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        const distance = Math.hypot(x - predictedLocal.x, y - predictedLocal.y);
        if (distance > searchRadius) continue;
        const index = (y * width + x) * 4;
        const sample = { r: frame[index], g: frame[index + 1], b: frame[index + 2] };
        const prior = previousPixel(previous, originX + x, originY + y);
        const pixelMotion = prior
          ? (Math.abs(sample.r - prior[0]) + Math.abs(sample.g - prior[1]) + Math.abs(sample.b - prior[2])) / (255 * 3)
          : 0;
        if (!candidateAllowed(sample, template, pixelMotion)) continue;

        const stats = patchScore({
          frame,
          width,
          height,
          x,
          y,
          radius: expectedRadius,
          template,
          previous,
          originX,
          originY,
        });
        const proximity = Math.exp(-2.4 * (distance / Math.max(1, searchRadius)) ** 2);
        const score = stats.meanSimilarity * 0.37
          + stats.meanMotion * 0.25
          + proximity * 0.23
          + stats.contrast * 0.08
          + stats.classFraction * 0.07;
        if (!best || score > best.score) {
          best = {
            x: originX + x,
            y: originY + y,
            score,
            ...stats,
          };
        }
      }
    }
    return best;
  }

  class AdaptiveSourceTracker {
    constructor(settings = {}) {
      this.settings = {
        maximumCropHalfSize: 310,
        minimumCropHalfSize: 86,
        maximumMissedFrames: 14,
        ...settings,
      };
      this.reset();
    }

    reset() {
      this.initialized = false;
      this.previous = null;
      this.pending = null;
      this.missedFrames = 0;
    }

    initialize({ sourceWidth, sourceHeight, x, y, time, template, velocity, initialRadius = 5 }) {
      this.sourceWidth = sourceWidth;
      this.sourceHeight = sourceHeight;
      this.position = { x, y };
      this.smoothed = { x, y };
      this.velocity = velocity || { x: 0, y: 0 };
      this.previousTime = time;
      this.startedAt = time;
      this.template = template;
      this.initialRadius = clamp(initialRadius, 1, 10);
      this.missedFrames = 0;
      this.pending = null;
      this.previous = null;
      this.initialized = true;
    }

    expectedRadius(time) {
      const elapsed = Math.max(0, time - this.startedAt);
      return clamp(this.initialRadius / (1 + elapsed * 1.35), 1, this.initialRadius);
    }

    predict(time) {
      const dt = clamp(time - this.previousTime, 1 / 300, 0.25);
      return {
        x: clamp(this.position.x + this.velocity.x * dt, 0, this.sourceWidth - 1),
        y: clamp(this.position.y + this.velocity.y * dt, 0, this.sourceHeight - 1),
        dt,
      };
    }

    nextCrop(time, fps = 30) {
      if (!this.initialized) throw new Error("AdaptiveSourceTracker must be initialized first.");
      const predicted = this.predict(time);
      const speed = Math.hypot(this.velocity.x, this.velocity.y);
      const expectedTravel = speed * predicted.dt;
      const fpsRelief = clamp(30 / Math.max(24, fps), 0.25, 1.25);
      const halfSize = clamp(
        66 + expectedTravel * 1.65 + this.missedFrames * 24 + 34 * fpsRelief,
        this.settings.minimumCropHalfSize,
        this.settings.maximumCropHalfSize,
      );
      return { centerX: predicted.x, centerY: predicted.y, halfSize: Math.round(halfSize) };
    }

    plausible(candidate, predicted, dt) {
      const relX = candidate.x - this.position.x;
      const relY = candidate.y - this.position.y;
      const distance = Math.hypot(relX, relY);
      const speed = Math.hypot(this.velocity.x, this.velocity.y);
      if (speed < 20 || distance < 2) return candidate.y <= this.position.y + 24;
      const ux = this.velocity.x / speed;
      const uy = this.velocity.y / speed;
      const along = relX * ux + relY * uy;
      const perpendicular = Math.abs(relX * uy - relY * ux);
      const expected = speed * dt;
      const corridor = clamp(10 + expected * 0.7 + this.missedFrames * 7, 14, 86);
      const forward = Math.max(36, expected * 2.8 + 18 + this.missedFrames * 12);
      const backward = Math.max(8, expected * 0.25 + this.missedFrames * 3);
      return along >= -backward && along <= forward && perpendicular <= corridor;
    }

    pendingConfirmed(candidate, predicted, dt) {
      if (!this.pending) return false;
      const pendingDt = Math.max(1 / 300, candidate.time - this.pending.time);
      const expectedX = this.pending.x + this.velocity.x * pendingDt;
      const expectedY = this.pending.y + this.velocity.y * pendingDt;
      const expectedTravel = Math.hypot(this.velocity.x, this.velocity.y) * dt;
      return Math.hypot(candidate.x - expectedX, candidate.y - expectedY) <= Math.max(12, expectedTravel * 1.3 + 8);
    }

    track({ frame, width, height, originX, originY, time, fps = 30 }) {
      if (!this.initialized) throw new Error("AdaptiveSourceTracker must be initialized first.");
      const predicted = this.predict(time);
      const radius = this.expectedRadius(time);
      const searchRadius = Math.min(
        Math.max(width, height) * 0.48,
        Math.max(42, Math.hypot(this.velocity.x, this.velocity.y) * predicted.dt * 2.2 + 34 + this.missedFrames * 14),
      );
      const candidate = findAdaptiveCandidate({
        frame,
        width,
        height,
        originX,
        originY,
        predicted,
        template: this.template,
        expectedRadius: radius,
        previous: this.previous,
        searchRadius,
      });

      const elapsed = time - this.startedAt;
      const farMode = radius <= 2.15 || elapsed >= 0.42;
      const threshold = farMode ? 0.39 : 0.47;
      let accepted = Boolean(candidate && candidate.score >= threshold && this.plausible(candidate, predicted, predicted.dt));
      if (accepted && farMode && candidate.score < 0.72 && !this.pendingConfirmed({ ...candidate, time }, predicted, predicted.dt)) {
        this.pending = { ...candidate, time };
        accepted = false;
      }

      let state;
      let confidence;
      let nextPosition;
      if (accepted) {
        state = "DETECTED";
        confidence = candidate.score;
        nextPosition = { x: candidate.x, y: candidate.y };
        const measuredVelocity = {
          x: (nextPosition.x - this.position.x) / predicted.dt,
          y: (nextPosition.y - this.position.y) / predicted.dt,
        };
        const blend = farMode ? 0.58 : 0.74;
        this.velocity = {
          x: this.velocity.x * (1 - blend) + measuredVelocity.x * blend,
          y: this.velocity.y * (1 - blend) + measuredVelocity.y * blend,
        };
        this.missedFrames = 0;
        this.pending = null;
      } else {
        this.missedFrames += 1;
        state = this.missedFrames <= this.settings.maximumMissedFrames ? "PREDICTED" : "LOST";
        confidence = Math.min(0.32, candidate?.score || 0.04);
        nextPosition = { x: predicted.x, y: predicted.y };
        this.velocity.x *= 0.97;
        this.velocity.y *= 0.97;
      }

      this.position = nextPosition;
      this.smoothed = {
        x: this.smoothed.x * 0.24 + nextPosition.x * 0.76,
        y: this.smoothed.y * 0.24 + nextPosition.y * 0.76,
      };
      this.previousTime = time;
      this.previous = {
        frame: new Uint8ClampedArray(frame),
        width,
        height,
        originX,
        originY,
      };

      const next = this.predict(time + 1 / Math.max(12, fps));
      return {
        state,
        x: nextPosition.x,
        y: nextPosition.y,
        smoothX: this.smoothed.x,
        smoothY: this.smoothed.y,
        sourceX: nextPosition.x,
        sourceY: nextPosition.y,
        confidence,
        time,
        launched: true,
        adaptive: true,
        expectedRadius: radius,
        nextX: next.x,
        nextY: next.y,
        candidateScore: candidate?.score || 0,
      };
    }
  }

  root.BallTraceAdaptive = Object.freeze({
    AdaptiveSourceTracker,
    FrameRateEstimator,
    estimateInitialRadius,
    findAdaptiveCandidate,
  });
})(typeof self !== "undefined" ? self : globalThis);
