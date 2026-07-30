(function attachBallTraceTrackingGuard(root) {
  "use strict";

  const core = root.BallTraceCore;
  if (!core?.Tracker || core.__rangeGuardVersion === 1) return;

  const BaseTracker = core.Tracker;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function pointXY(point) {
    return {
      x: point.smoothX ?? point.x,
      y: point.smoothY ?? point.y,
      time: point.time,
    };
  }

  function snapshotTracker(tracker) {
    return {
      previousFrame: tracker.previousFrame,
      position: tracker.position && { ...tracker.position },
      smoothed: tracker.smoothed && { ...tracker.smoothed },
      velocity: tracker.velocity && { ...tracker.velocity },
      previousTime: tracker.previousTime,
      missedFrames: tracker.missedFrames,
      launched: tracker.launched,
    };
  }

  function restoreTracker(tracker, snapshot) {
    tracker.previousFrame = snapshot.previousFrame;
    tracker.position = snapshot.position && { ...snapshot.position };
    tracker.smoothed = snapshot.smoothed && { ...snapshot.smoothed };
    tracker.velocity = snapshot.velocity && { ...snapshot.velocity };
    tracker.previousTime = snapshot.previousTime;
    tracker.missedFrames = snapshot.missedFrames;
    tracker.launched = snapshot.launched;
  }

  function consistentDetectedPoints(points) {
    const detected = points.filter((point) => point?.state === "DETECTED");
    if (detected.length < 3) return detected;

    const accepted = [detected[0], detected[1]];
    for (let index = 2; index < detected.length; index += 1) {
      const candidate = detected[index];
      const previous = pointXY(accepted.at(-1));
      const before = pointXY(accepted.at(-2));
      const current = pointXY(candidate);
      const previousDx = previous.x - before.x;
      const previousDy = previous.y - before.y;
      const currentDx = current.x - previous.x;
      const currentDy = current.y - previous.y;
      const previousDistance = Math.hypot(previousDx, previousDy);
      const currentDistance = Math.hypot(currentDx, currentDy);

      if (previousDistance > 5 && currentDistance > 5) {
        const cosine = (previousDx * currentDx + previousDy * currentDy)
          / (previousDistance * currentDistance);
        if (cosine < 0.25) continue;
        const ratio = currentDistance / previousDistance;
        if (ratio > 4.6 || ratio < 0.08) continue;
      }

      if (accepted.length < 7 && current.y > previous.y + Math.max(12, currentDistance * 0.38)) {
        continue;
      }
      accepted.push(candidate);
    }
    return accepted;
  }

  class GuardedTracker extends BaseTracker {
    reset() {
      super.reset();
      this._rangeGuardAccepted = [];
      this._rangeGuardRejected = 0;
    }

    initialize(input) {
      const point = super.initialize(input);
      this._rangeGuardAccepted = [point];
      this._rangeGuardRejected = 0;
      return { ...point, guardAccepted: true };
    }

    _accept(point) {
      this._rangeGuardAccepted.push(point);
      if (this._rangeGuardAccepted.length > 10) this._rangeGuardAccepted.shift();
      return { ...point, guardAccepted: true, guardRejectedCount: this._rangeGuardRejected };
    }

    _isPlausible(point, snapshot) {
      if (point.state !== "DETECTED") return true;
      const history = this._rangeGuardAccepted;
      if (history.length < 2) {
        const start = pointXY(history[0]);
        const next = pointXY(point);
        return !point.launched || next.y <= start.y + 18;
      }

      const last = pointXY(history.at(-1));
      const previous = pointXY(history.at(-2));
      const current = pointXY(point);
      const baseDx = last.x - previous.x;
      const baseDy = last.y - previous.y;
      const baseDistance = Math.hypot(baseDx, baseDy);
      const dtBase = Math.max(1 / 240, last.time - previous.time);
      const dtCurrent = Math.max(1 / 240, current.time - last.time);

      if (!point.launched || baseDistance < 4) {
        return current.y <= last.y + 20;
      }

      const ux = baseDx / baseDistance;
      const uy = baseDy / baseDistance;
      const expectedDistance = baseDistance * dtCurrent / dtBase;
      const relX = current.x - last.x;
      const relY = current.y - last.y;
      const along = relX * ux + relY * uy;
      const perpendicular = Math.abs(relX * uy - relY * ux);
      const missCount = snapshot.missedFrames || 0;
      const corridorWidth = clamp(14 + expectedDistance * 0.42 + missCount * 7, 16, 72);
      const forwardLimit = Math.max(42, expectedDistance * 2.05 + 24 + missCount * 12);
      const backwardLimit = Math.max(10, expectedDistance * 0.28 + missCount * 4);
      if (along < -backwardLimit || along > forwardLimit || perpendicular > corridorWidth) return false;

      const currentDistance = Math.hypot(relX, relY);
      if (currentDistance > 7) {
        const cosine = (baseDx * relX + baseDy * relY) / (baseDistance * currentDistance);
        const minimumCosine = missCount > 0 ? 0.05 : 0.28;
        if (cosine < minimumCosine) return false;
      }

      if (history.length < 7 && current.y > last.y + Math.max(12, currentDistance * 0.38)) {
        return false;
      }

      const speedRatio = currentDistance / Math.max(1, expectedDistance);
      if (speedRatio > 4.8 || speedRatio < 0.06) return false;
      return true;
    }

    _rejectDetection({ frame, time }, snapshot, rejectedPoint) {
      restoreTracker(this, snapshot);
      const dt = clamp(time - snapshot.previousTime, 1 / 240, 0.4);
      const predicted = {
        x: clamp(snapshot.position.x + snapshot.velocity.x * dt, 0, this.width - 1),
        y: clamp(snapshot.position.y + snapshot.velocity.y * dt, 0, this.height - 1),
      };
      const missedFrames = snapshot.missedFrames + 1;
      const state = missedFrames <= this.settings.maxPredictedGapFrames ? "PREDICTED" : "LOST";
      this.position = predicted;
      this.smoothed = {
        x: snapshot.smoothed.x * 0.3 + predicted.x * 0.7,
        y: snapshot.smoothed.y * 0.3 + predicted.y * 0.7,
      };
      this.velocity = {
        x: snapshot.velocity.x * 0.94,
        y: snapshot.velocity.y * 0.94,
      };
      this.previousFrame = new Uint8ClampedArray(frame);
      this.previousTime = time;
      this.missedFrames = missedFrames;
      this.launched = snapshot.launched;
      this._rangeGuardRejected += 1;
      return {
        ...rejectedPoint,
        state,
        x: predicted.x,
        y: predicted.y,
        smoothX: this.smoothed.x,
        smoothY: this.smoothed.y,
        confidence: Math.min(0.24, rejectedPoint.confidence || 0),
        time,
        launched: this.launched,
        guardRejected: true,
        guardRejectedCount: this._rangeGuardRejected,
      };
    }

    track(input) {
      const snapshot = snapshotTracker(this);
      const point = super.track(input);
      if (point.state === "DETECTED" && !this._isPlausible(point, snapshot)) {
        return this._rejectDetection(input, snapshot, point);
      }
      if (point.state === "DETECTED") return this._accept(point);
      return { ...point, guardRejectedCount: this._rangeGuardRejected };
    }
  }

  let trajectory = root.BallTraceTrajectory;
  if (trajectory?.buildPredictedTrajectory && !trajectory.__rangeGuardVersion) {
    const originalBuild = trajectory.buildPredictedTrajectory;
    trajectory = Object.freeze({
      ...trajectory,
      buildPredictedTrajectory(input) {
        return originalBuild({
          ...input,
          points: consistentDetectedPoints(Array.isArray(input.points) ? input.points : []),
        });
      },
      consistentDetectedPoints,
      __rangeGuardVersion: 1,
    });
    root.BallTraceTrajectory = trajectory;
  }

  root.BallTraceCore = Object.freeze({
    ...core,
    Tracker: GuardedTracker,
    consistentDetectedPoints,
    __rangeGuardVersion: 1,
  });
})(typeof self !== "undefined" ? self : globalThis);
