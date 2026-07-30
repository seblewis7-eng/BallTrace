(function attachBallTraceCore(root) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    sampleRadius: 2,
    detailRadius: 6,
    templateRadius: 7,
    preLaunchSearchRadius: 82,
    launchSearchRadius: 320,
    launchedSearchRadiusMin: 90,
    launchedSearchRadiusMax: 390,
    detectedThreshold: 0.56,
    launchThreshold: 0.53,
    reacquireThreshold: 0.58,
    maxPredictedGapFrames: 5,
    launchSpeedPxPerSecond: 105,
    launchDistancePx: 8,
    smoothingAlpha: 0.7,
    minBrightness: 0.3,
    gridStep: 2,
    wideGridStep: 3,
    topCandidateCount: 14,
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
    const white = hsv.v > 0.54 && hsv.s < 0.4;
    const yellow = hsv.v > 0.42 && hsv.s > 0.22 && hsv.h >= 26 && hsv.h <= 86;
    return white ? "white" : yellow ? "yellow" : "other";
  }

  function colourSimilarity(sample, template) {
    const sampleHsv = rgbToHsv(sample.r, sample.g, sample.b);
    const templateHsv = rgbToHsv(template.r, template.g, template.b);
    const rgbDistance = Math.hypot(
      sample.r - template.r,
      sample.g - template.g,
      sample.b - template.b,
    ) / 441.673;
    const hueDistance = circularHueDistance(sampleHsv.h, templateHsv.h);
    const saturationDistance = Math.abs(sampleHsv.s - templateHsv.s);
    const valueDistance = Math.abs(sampleHsv.v - templateHsv.v);
    const hueWeight = templateHsv.s > 0.2 ? 0.34 : 0.07;
    const score = 1 - (
      rgbDistance * 0.43
      + hueDistance * hueWeight
      + saturationDistance * 0.17
      + valueDistance * (0.4 - hueWeight)
    );
    const sampleClass = classifyColour(sample.r, sample.g, sample.b);
    const templateClass = template.className || classifyColour(template.r, template.g, template.b);
    return clamp(score * (sampleClass === templateClass ? 1 : 0.72), 0, 1);
  }

  function pixelMatchesClass(r, g, b, className) {
    if (className === "yellow") return classifyColour(r, g, b) === "yellow";
    if (className === "white") return classifyColour(r, g, b) === "white";
    return false;
  }

  function samplePatch(frame, width, height, x, y, radius = DEFAULT_SETTINGS.templateRadius) {
    const minX = clamp(Math.floor(x - radius), 0, width - 1);
    const maxX = clamp(Math.ceil(x + radius), 0, width - 1);
    const minY = clamp(Math.floor(y - radius), 0, height - 1);
    const maxY = clamp(Math.ceil(y + radius), 0, height - 1);
    const pixels = [];
    const classCounts = { white: 0, yellow: 0, other: 0 };
    const centreIndex = (clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1)) * 4;
    const centreClass = classifyColour(frame[centreIndex], frame[centreIndex + 1], frame[centreIndex + 2]);

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        if (Math.hypot(px - x, py - y) > radius) continue;
        const index = (py * width + px) * 4;
        const pixel = {
          r: frame[index],
          g: frame[index + 1],
          b: frame[index + 2],
        };
        pixel.className = classifyColour(pixel.r, pixel.g, pixel.b);
        pixel.luminance = luminance(pixel.r, pixel.g, pixel.b);
        classCounts[pixel.className] += 1;
        pixels.push(pixel);
      }
    }

    let className = centreClass;
    if (className === "other") {
      const meaningfulMinimum = Math.max(3, Math.round(pixels.length * 0.035));
      if (classCounts.yellow >= meaningfulMinimum) className = "yellow";
      else if (classCounts.white >= meaningfulMinimum) className = "white";
    }

    let selected = className === "other" ? [] : pixels.filter((pixel) => pixel.className === className);
    if (selected.length < 3) {
      const sorted = [...pixels].sort((a, b) => b.luminance - a.luminance);
      selected = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.18)));
      const selectedClassCounts = selected.reduce((counts, pixel) => {
        counts[pixel.className] += 1;
        return counts;
      }, { white: 0, yellow: 0, other: 0 });
      className = selectedClassCounts.yellow > selectedClassCounts.white
        ? "yellow"
        : selectedClassCounts.white > 0
          ? "white"
          : "other";
    }

    const colour = selected.reduce((sum, pixel) => ({
      r: sum.r + pixel.r,
      g: sum.g + pixel.g,
      b: sum.b + pixel.b,
    }), { r: 0, g: 0, b: 0 });
    colour.r /= selected.length;
    colour.g /= selected.length;
    colour.b /= selected.length;
    const hsv = rgbToHsv(colour.r, colour.g, colour.b);

    return {
      ...colour,
      ...hsv,
      luminance: luminance(colour.r, colour.g, colour.b),
      className,
      coverage: selected.length / Math.max(1, pixels.length),
    };
  }

  function quickPatchStats(frame, previousFrame, width, height, x, y, radius, template) {
    const minX = clamp(x - radius, 0, width - 1);
    const maxX = clamp(x + radius, 0, width - 1);
    const minY = clamp(y - radius, 0, height - 1);
    const maxY = clamp(y + radius, 0, height - 1);
    let r = 0;
    let g = 0;
    let b = 0;
    let matchedR = 0;
    let matchedG = 0;
    let matchedB = 0;
    let matchedCount = 0;
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
        r += pr;
        g += pg;
        b += pb;
        count += 1;
        if (pixelMatchesClass(pr, pg, pb, template.className)) {
          matchedR += pr;
          matchedG += pg;
          matchedB += pb;
          matchedCount += 1;
        }
        const dx = Math.abs(px - x);
        const dy = Math.abs(py - y);
        if (dx <= 1 && dy <= 1) {
          centreLum += lum;
          centreCount += 1;
        } else if (dx === radius || dy === radius) {
          edgeLum += lum;
          edgeCount += 1;
        }
        if (previousFrame) {
          motion += (
            Math.abs(pr - previousFrame[index])
            + Math.abs(pg - previousFrame[index + 1])
            + Math.abs(pb - previousFrame[index + 2])
          ) / (255 * 3);
        }
      }
    }

    const useMatched = matchedCount >= 2;
    return {
      r: useMatched ? matchedR / matchedCount : r / count,
      g: useMatched ? matchedG / matchedCount : g / count,
      b: useMatched ? matchedB / matchedCount : b / count,
      motion: previousFrame ? motion / count : 0,
      contrast: clamp(Math.abs(
        centreLum / Math.max(1, centreCount)
        - edgeLum / Math.max(1, edgeCount)
      ) * 2.2, 0, 1),
      matchFraction: matchedCount / count,
    };
  }

  function detailedShapeStats(frame, width, height, x, y, template, innerRadius, outerRadius) {
    const minX = clamp(x - outerRadius, 0, width - 1);
    const maxX = clamp(x + outerRadius, 0, width - 1);
    const minY = clamp(y - outerRadius, 0, height - 1);
    const maxY = clamp(y + outerRadius, 0, height - 1);
    let innerMatches = 0;
    let innerCount = 0;
    let outerMatches = 0;
    let outerCount = 0;
    let matchedR = 0;
    let matchedG = 0;
    let matchedB = 0;
    let matchedCount = 0;
    let sumDx = 0;
    let sumDy = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const radialDistance = Math.hypot(px - x, py - y);
        if (radialDistance > outerRadius) continue;
        const index = (py * width + px) * 4;
        const pr = frame[index];
        const pg = frame[index + 1];
        const pb = frame[index + 2];
        const matches = pixelMatchesClass(pr, pg, pb, template.className);
        if (radialDistance <= innerRadius) {
          innerCount += 1;
          if (matches) innerMatches += 1;
        } else {
          outerCount += 1;
          if (matches) outerMatches += 1;
        }
        if (matches) {
          matchedR += pr;
          matchedG += pg;
          matchedB += pb;
          matchedCount += 1;
          const dx = px - x;
          const dy = py - y;
          sumDx += dx;
          sumDy += dy;
          sumXX += dx * dx;
          sumYY += dy * dy;
          sumXY += dx * dy;
        }
      }
    }

    const innerFraction = innerMatches / Math.max(1, innerCount);
    const outerFraction = outerMatches / Math.max(1, outerCount);
    const compactness = clamp(0.45 + innerFraction - outerFraction * 0.9, 0, 1);
    const detailColour = matchedCount >= 2
      ? colourSimilarity({ r: matchedR / matchedCount, g: matchedG / matchedCount, b: matchedB / matchedCount }, template)
      : 0;
    let circularity = 0;
    let centredness = 0;
    if (matchedCount >= 3) {
      const meanX = sumDx / matchedCount;
      const meanY = sumDy / matchedCount;
      const covXX = Math.max(0, sumXX / matchedCount - meanX * meanX);
      const covYY = Math.max(0, sumYY / matchedCount - meanY * meanY);
      const covXY = sumXY / matchedCount - meanX * meanY;
      const trace = covXX + covYY;
      const determinant = Math.max(0, covXX * covYY - covXY * covXY);
      const rootValue = Math.sqrt(Math.max(0, trace * trace / 4 - determinant));
      const major = trace / 2 + rootValue;
      const minor = trace / 2 - rootValue;
      circularity = major > 0 ? clamp(minor / major, 0, 1) : 1;
      centredness = Math.exp(-0.7 * (meanX * meanX + meanY * meanY) / Math.max(1, innerRadius * innerRadius));
    }
    return { compactness, detailColour, innerFraction, outerFraction, circularity, centredness };
  }

  function coarseCandidateScore({ stats, template, distanceFromPrediction, searchRadius, mode }) {
    const colour = colourSimilarity(stats, template);
    const motion = clamp(stats.motion * 3.5, 0, 1);
    const proximity = Math.exp(-2.2 * (distanceFromPrediction / Math.max(1, searchRadius)) ** 2);
    const brightness = clamp(luminance(stats.r, stats.g, stats.b) / Math.max(0.3, template.luminance), 0, 1);
    let score;
    if (mode === "launch") {
      score = colour * 0.3
        + motion * 0.28
        + stats.matchFraction * 0.18
        + stats.contrast * 0.08
        + brightness * 0.08
        + proximity * 0.08;
    } else if (mode === "launched") {
      score = colour * 0.35
        + proximity * 0.19
        + motion * 0.18
        + stats.matchFraction * 0.13
        + stats.contrast * 0.07
        + brightness * 0.08;
    } else {
      score = colour * 0.4
        + proximity * 0.27
        + stats.matchFraction * 0.12
        + motion * 0.08
        + stats.contrast * 0.06
        + brightness * 0.07;
    }
    return { score, colour, motion, proximity, matchFraction: stats.matchFraction, contrast: stats.contrast };
  }

  function findBestCandidate({
    frame,
    previousFrame,
    width,
    height,
    predicted,
    searchRadius,
    template,
    settings,
    mode = "local",
    step = settings.gridStep,
  }) {
    const radius = settings.sampleRadius;
    const minX = clamp(Math.floor(predicted.x - searchRadius), radius, width - radius - 1);
    const maxX = clamp(Math.ceil(predicted.x + searchRadius), radius, width - radius - 1);
    const minY = clamp(Math.floor(predicted.y - searchRadius), radius, height - radius - 1);
    const maxY = clamp(Math.ceil(predicted.y + searchRadius), radius, height - radius - 1);
    const topCandidates = [];

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
        if (template.className !== "other" && centreClass !== template.className && centreLum < settings.minBrightness) continue;
        if (template.className === "yellow" && centreClass !== "yellow") continue;

        const stats = quickPatchStats(frame, previousFrame, width, height, x, y, radius, template);
        const components = coarseCandidateScore({
          stats,
          template,
          distanceFromPrediction: dist,
          searchRadius,
          mode,
        });
        const candidate = { x, y, ...components };
        const separation = Math.max(settings.detailRadius * 1.5, step * 2);
        const nearbyIndex = topCandidates.findIndex((existing) => (
          Math.hypot(existing.x - candidate.x, existing.y - candidate.y) < separation
        ));
        if (nearbyIndex >= 0) {
          if (candidate.score > topCandidates[nearbyIndex].score) topCandidates[nearbyIndex] = candidate;
        } else if (topCandidates.length < settings.topCandidateCount) {
          topCandidates.push(candidate);
        } else {
          topCandidates.sort((a, b) => b.score - a.score);
          if (candidate.score > topCandidates.at(-1).score) topCandidates[topCandidates.length - 1] = candidate;
        }
        topCandidates.sort((a, b) => b.score - a.score);
      }
    }

    let best = null;
    for (const candidate of topCandidates) {
      const shape = detailedShapeStats(
        frame,
        width,
        height,
        candidate.x,
        candidate.y,
        template,
        settings.sampleRadius + 1,
        settings.detailRadius,
      );
      const finalScore = candidate.score * 0.55
        + shape.compactness * 0.15
        + shape.detailColour * 0.08
        + shape.circularity * 0.12
        + shape.centredness * 0.1
        - shape.outerFraction * 0.1;
      const detailed = { ...candidate, ...shape, score: finalScore };
      if (!best || detailed.score > best.score) best = detailed;
    }
    return best;
  }

  class Tracker {
    constructor(settings = {}) {
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
      this.reset();
    }

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
      this.template = template || samplePatch(frame, width, height, x, y, this.settings.templateRadius);
      this.previousFrame = new Uint8ClampedArray(frame);
      this.startedAt = time;
      this.previousTime = time;
      this.missedFrames = 0;
      this.launched = false;
      this.initialized = true;
      return {
        state: "DETECTED",
        x,
        y,
        smoothX: x,
        smoothY: y,
        confidence: 1,
        time,
        searchRadius: this.settings.preLaunchSearchRadius,
        launched: false,
        templateClass: this.template.className,
      };
    }

    track({ frame, time }) {
      if (!this.initialized) throw new Error("Tracker must be initialized before track().");
      const dt = clamp(time - this.previousTime, 1 / 240, 0.4);
      const predicted = {
        x: clamp(this.position.x + this.velocity.x * dt, 0, this.width - 1),
        y: clamp(this.position.y + this.velocity.y * dt, 0, this.height - 1),
      };
      const speed = Math.hypot(this.velocity.x, this.velocity.y);
      const searchRadius = this.launched
        ? clamp(speed * dt * 1.9 + 64, this.settings.launchedSearchRadiusMin, this.settings.launchedSearchRadiusMax)
        : this.settings.preLaunchSearchRadius;
      let candidate = findBestCandidate({
        frame,
        previousFrame: this.previousFrame,
        width: this.width,
        height: this.height,
        predicted,
        searchRadius,
        template: this.template,
        settings: this.settings,
        mode: this.launched ? "launched" : "local",
      });
      let threshold = this.missedFrames > 0 ? this.settings.reacquireThreshold : this.settings.detectedThreshold;
      let usedSearchRadius = searchRadius;

      const localJump = candidate ? distance(candidate, this.position) : Infinity;
      const needsLaunchSearch = !this.launched && (
        !candidate
        || candidate.score < threshold
        || localJump > this.settings.launchDistancePx * 2.5
        || candidate.compactness < 0.68
        || candidate.circularity < 0.42
      );
      if (needsLaunchSearch) {
        const wideCandidate = findBestCandidate({
          frame,
          previousFrame: this.previousFrame,
          width: this.width,
          height: this.height,
          predicted: this.position,
          searchRadius: this.settings.launchSearchRadius,
          template: this.template,
          settings: this.settings,
          mode: "launch",
          step: this.settings.wideGridStep,
        });
        if (wideCandidate && (!candidate || wideCandidate.score > candidate.score)) candidate = wideCandidate;
        threshold = this.settings.launchThreshold;
        usedSearchRadius = this.settings.launchSearchRadius;
      }

      let state;
      let confidence;
      let nextPosition;
      if (candidate && candidate.score >= threshold) {
        state = "DETECTED";
        confidence = candidate.score;
        nextPosition = { x: candidate.x, y: candidate.y };
        const measuredVelocity = {
          x: (nextPosition.x - this.position.x) / dt,
          y: (nextPosition.y - this.position.y) / dt,
        };
        const blend = this.launched ? 0.78 : 0.64;
        this.velocity = {
          x: this.velocity.x * (1 - blend) + measuredVelocity.x * blend,
          y: this.velocity.y * (1 - blend) + measuredVelocity.y * blend,
        };
        this.missedFrames = 0;
      } else if (this.missedFrames < this.settings.maxPredictedGapFrames) {
        state = "PREDICTED";
        confidence = Math.max(0.04, (candidate?.score || 0) * 0.62);
        nextPosition = predicted;
        this.velocity.x *= 0.95;
        this.velocity.y *= 0.95;
        this.missedFrames += 1;
      } else {
        state = "LOST";
        confidence = candidate?.score || 0;
        nextPosition = predicted;
        this.previousFrame = new Uint8ClampedArray(frame);
        this.previousTime = time;
        return {
          state,
          x: nextPosition.x,
          y: nextPosition.y,
          smoothX: this.smoothed.x,
          smoothY: this.smoothed.y,
          confidence,
          time,
          searchRadius: usedSearchRadius,
          launched: this.launched,
          templateClass: this.template.className,
        };
      }

      this.position = nextPosition;
      const alpha = this.settings.smoothingAlpha;
      this.smoothed = {
        x: this.smoothed.x * (1 - alpha) + nextPosition.x * alpha,
        y: this.smoothed.y * (1 - alpha) + nextPosition.y * alpha,
      };
      const distanceFromStart = distance(this.position, this.initialPosition);
      const currentSpeed = Math.hypot(this.velocity.x, this.velocity.y);
      if (!this.launched && (
        currentSpeed >= this.settings.launchSpeedPxPerSecond
        || distanceFromStart >= this.settings.launchDistancePx
      )) this.launched = true;
      this.previousFrame = new Uint8ClampedArray(frame);
      this.previousTime = time;
      return {
        state,
        x: nextPosition.x,
        y: nextPosition.y,
        smoothX: this.smoothed.x,
        smoothY: this.smoothed.y,
        confidence,
        time,
        searchRadius: usedSearchRadius,
        launched: this.launched,
        templateClass: this.template.className,
      };
    }
  }

  root.BallTraceCore = Object.freeze({
    DEFAULT_SETTINGS,
    Tracker,
    classifyColour,
    colourSimilarity,
    findBestCandidate,
    luminance,
    rgbToHsv,
    samplePatch,
  });
})(typeof self !== "undefined" ? self : globalThis);
