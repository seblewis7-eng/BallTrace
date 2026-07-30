(function attachBallTraceStrictReacquisition(root) {
  "use strict";

  const adaptive = root.BallTraceAdaptive;
  if (!adaptive?.AdaptiveSourceTracker || adaptive.__strictReacquisitionVersion === 2) return;

  const BaseAdaptiveTracker = adaptive.AdaptiveSourceTracker;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function pointXY(point) {
    return {
      x: point?.smoothX ?? point?.x ?? 0,
      y: point?.smoothY ?? point?.y ?? 0,
      time: point?.time ?? 0,
    };
  }

  function normalizedDirection(vector, fallback = { x: 0, y: -1 }) {
    const magnitude = Math.hypot(vector?.x || 0, vector?.y || 0);
    if (magnitude < 1e-6) return { ...fallback };
    return { x: vector.x / magnitude, y: vector.y / magnitude };
  }

  function snapshotTracker(tracker) {
    return {
      previous: tracker.previous,
      pending: tracker.pending && { ...tracker.pending },
      missedFrames: tracker.missedFrames,
      position: tracker.position && { ...tracker.position },
      smoothed: tracker.smoothed && { ...tracker.smoothed },
      velocity: tracker.velocity && { ...tracker.velocity },
      previousTime: tracker.previousTime,
    };
  }

  function restoreTracker(tracker, snapshot) {
    tracker.previous = snapshot.previous;
    tracker.pending = snapshot.pending && { ...snapshot.pending };
    tracker.missedFrames = snapshot.missedFrames;
    tracker.position = snapshot.position && { ...snapshot.position };
    tracker.smoothed = snapshot.smoothed && { ...snapshot.smoothed };
    tracker.velocity = snapshot.velocity && { ...snapshot.velocity };
    tracker.previousTime = snapshot.previousTime;
  }

  function flightLockedPoints(points) {
    const detected = (Array.isArray(points) ? points : []).filter((point) => (
      point?.state === "DETECTED" && !point.provisionalReacquisition
    ));
    if (detected.length < 3) return detected;

    const accepted = [detected[0]];
    let anchor = pointXY(detected[0]);
    let direction = null;
    let descending = false;
    let downwardSteps = 0;

    for (let index = 1; index < detected.length; index += 1) {
      const candidate = detected[index];
      const current = pointXY(candidate);
      const last = pointXY(accepted.at(-1));
      const dx = current.x - last.x;
      const dy = current.y - last.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.35) {
        accepted.push(candidate);
        continue;
      }

      if (!direction) {
        if (distance < 4) {
          accepted.push(candidate);
          continue;
        }
        anchor = last;
        direction = normalizedDirection({ x: dx, y: dy });
        accepted.push(candidate);
        continue;
      }

      const fromAnchorX = current.x - anchor.x;
      const fromAnchorY = current.y - anchor.y;
      const along = fromAnchorX * direction.x + fromAnchorY * direction.y;
      const across = Math.abs(fromAnchorX * direction.y - fromAnchorY * direction.x);
      const gap = Math.max(0, current.time - last.time);
      const corridor = clamp(14 + Math.max(0, along) * 0.25 + gap * 88, 16, 108);
      if (along < -12 || across > corridor) continue;

      const previous = accepted.length >= 2 ? pointXY(accepted.at(-2)) : anchor;
      const previousDx = last.x - previous.x;
      const previousDy = last.y - previous.y;
      const previousDistance = Math.hypot(previousDx, previousDy);
      if (previousDistance > 3 && distance > 3) {
        const cosine = (previousDx * dx + previousDy * dy) / (previousDistance * distance);
        if (cosine < (candidate.reacquisitionConfirmed ? 0.04 : 0.22)) continue;
        const ratio = distance / previousDistance;
        if (ratio > 5.2 || ratio < 0.05) continue;
      }

      if (!descending) {
        const allowedDrop = Math.max(6, distance * 0.25 + gap * 24);
        if (dy > allowedDrop) continue;
        downwardSteps = dy > 1.5 ? downwardSteps + 1 : 0;
        const elapsed = current.time - anchor.time;
        const rise = anchor.y - current.y;
        if (elapsed > 0.85 && rise > 24 && downwardSteps >= 3) descending = true;
      }
      accepted.push(candidate);
    }
    return accepted;
  }

  class StrictAdaptiveTracker extends BaseAdaptiveTracker {
    constructor(settings = {}) {
      super(settings);
      this._strictSettings = {
        confirmationFrames: 3,
        lossFramesBeforeConfirmation: 2,
        minimumReacquireScore: 0.48,
        ...settings.strictReacquisition,
      };
      this._strictReset();
    }

    _strictReset() {
      this._strictTrusted = [];
      this._strictProvisional = [];
      this._strictSearching = false;
      this._strictConsecutiveMisses = 0;
      this._strictRejected = 0;
      this._strictAnchor = null;
      this._strictLaunchDirection = { x: 0, y: -1 };
      this._strictDescending = false;
    }

    reset() {
      super.reset();
      this._strictReset();
    }

    initialize(input) {
      super.initialize(input);
      this._strictReset();
      this._strictAnchor = { x: input.x, y: input.y, time: input.time };
      this._strictLaunchDirection = normalizedDirection(input.velocity, { x: 0, y: -1 });
    }

    _acceptTrusted(point) {
      const trusted = {
        ...point,
        provisionalReacquisition: false,
        strictSearching: false,
      };
      this._strictTrusted.push(trusted);
      if (this._strictTrusted.length > 18) this._strictTrusted.shift();
      this._strictConsecutiveMisses = 0;
      this._strictProvisional = [];

      if (!this._strictDescending && this._strictTrusted.length >= 5) {
        const recent = this._strictTrusted.slice(-5).map(pointXY);
        const downward = recent.slice(1).filter((item, index) => item.y - recent[index].y > 2).length;
        const elapsed = recent.at(-1).time - (this._strictAnchor?.time ?? recent[0].time);
        const rise = (this._strictAnchor?.y ?? recent[0].y) - recent.at(-1).y;
        if (elapsed > 0.85 && rise > 60 && downward >= 3) this._strictDescending = true;
      }
      return trusted;
    }

    _trustedDirection() {
      if (this._strictTrusted.length >= 2) {
        const first = pointXY(this._strictTrusted.at(-2));
        const last = pointXY(this._strictTrusted.at(-1));
        return normalizedDirection({ x: last.x - first.x, y: last.y - first.y }, this._strictLaunchDirection);
      }
      return this._strictLaunchDirection;
    }

    _plausible(point, snapshot) {
      const candidate = pointXY(point);
      const last = this._strictTrusted.length
        ? pointXY(this._strictTrusted.at(-1))
        : { ...this._strictAnchor };
      if (!last || !Number.isFinite(last.x) || !Number.isFinite(last.y)) return true;

      const dt = Math.max(1 / 300, candidate.time - last.time);
      const relX = candidate.x - last.x;
      const relY = candidate.y - last.y;
      const distance = Math.hypot(relX, relY);
      const direction = this._trustedDirection();
      const along = relX * direction.x + relY * direction.y;
      const across = Math.abs(relX * direction.y - relY * direction.x);
      const speed = Math.hypot(snapshot.velocity?.x || 0, snapshot.velocity?.y || 0);
      const expected = Math.max(1, speed * dt);
      const misses = snapshot.missedFrames || 0;
      const corridor = clamp(16 + expected * 0.62 + misses * 8, 20, 112);
      const forward = Math.max(48, expected * 2.8 + 28 + misses * 14);
      const backward = Math.max(10, expected * 0.24 + misses * 4);
      if (along < -backward || along > forward || across > corridor) return false;

      const anchor = this._strictAnchor || last;
      const fromAnchorX = candidate.x - anchor.x;
      const fromAnchorY = candidate.y - anchor.y;
      const launchAlong = fromAnchorX * this._strictLaunchDirection.x + fromAnchorY * this._strictLaunchDirection.y;
      const launchAcross = Math.abs(fromAnchorX * this._strictLaunchDirection.y - fromAnchorY * this._strictLaunchDirection.x);
      const launchCorridor = clamp(28 + Math.max(0, launchAlong) * 0.25 + misses * 9, 32, 150);
      if (launchAlong < -20 || launchAcross > launchCorridor) return false;

      if (!this._strictDescending) {
        const allowedDrop = Math.max(10, expected * 0.25 + misses * 5);
        if (relY > allowedDrop) return false;
        const elapsed = candidate.time - anchor.time;
        if (elapsed < 1.35 && candidate.y > anchor.y + 20) return false;
      }

      if (distance > 5) {
        const cosine = along / distance;
        if (cosine < (misses > 0 ? 0.02 : 0.25)) return false;
      }
      return true;
    }

    _provisionalConsistent(point, fps) {
      const candidate = pointXY(point);
      const previous = this._strictProvisional.at(-1);
      if (!previous) return true;
      const prior = pointXY(previous);
      const dt = candidate.time - prior.time;
      if (dt <= 0 || dt > Math.max(0.14, 2.8 / Math.max(12, fps))) return false;
      const dx = candidate.x - prior.x;
      const dy = candidate.y - prior.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.4) return false;
      const direction = this._trustedDirection();
      const cosine = (dx * direction.x + dy * direction.y) / distance;
      if (cosine < 0.05) return false;
      const across = Math.abs(dx * direction.y - dy * direction.x);
      return across <= Math.max(16, distance * 0.75 + 8);
    }

    _predictedMiss(input, snapshot, raw, reason) {
      restoreTracker(this, snapshot);
      const dt = clamp(input.time - snapshot.previousTime, 1 / 300, 0.25);
      const predicted = {
        x: clamp(snapshot.position.x + snapshot.velocity.x * dt, 0, this.sourceWidth - 1),
        y: clamp(snapshot.position.y + snapshot.velocity.y * dt, 0, this.sourceHeight - 1),
      };
      const missedFrames = snapshot.missedFrames + 1;
      this.position = predicted;
      this.smoothed = {
        x: snapshot.smoothed.x * 0.28 + predicted.x * 0.72,
        y: snapshot.smoothed.y * 0.28 + predicted.y * 0.72,
      };
      this.velocity = { x: snapshot.velocity.x * 0.985, y: snapshot.velocity.y * 0.985 };
      this.previousTime = input.time;
      this.previous = {
        frame: new Uint8ClampedArray(input.frame),
        width: input.width,
        height: input.height,
        originX: input.originX,
        originY: input.originY,
      };
      this.pending = null;
      this.missedFrames = missedFrames;
      this._strictConsecutiveMisses += 1;
      if (this._strictConsecutiveMisses >= this._strictSettings.lossFramesBeforeConfirmation
        && this._strictTrusted.length >= 2) {
        this._strictSearching = true;
      }
      this._strictRejected += reason === "confirming" ? 0 : 1;
      const state = missedFrames <= this.settings.maximumMissedFrames ? "PREDICTED" : "LOST";
      const next = this.predict(input.time + 1 / Math.max(12, input.fps || 30));
      return {
        ...raw,
        state,
        x: predicted.x,
        y: predicted.y,
        smoothX: this.smoothed.x,
        smoothY: this.smoothed.y,
        sourceX: predicted.x,
        sourceY: predicted.y,
        confidence: Math.min(0.32, raw?.confidence || raw?.candidateScore || 0.04),
        time: input.time,
        nextX: next.x,
        nextY: next.y,
        provisionalReacquisition: reason === "confirming",
        strictRejected: reason !== "confirming",
        strictSearching: this._strictSearching,
        strictReason: reason,
        strictRejectedCount: this._strictRejected,
      };
    }

    track(input) {
      const snapshot = snapshotTracker(this);
      const point = super.track(input);

      if (point.state !== "DETECTED") {
        this._strictConsecutiveMisses += 1;
        this._strictProvisional = [];
        if (this._strictConsecutiveMisses >= this._strictSettings.lossFramesBeforeConfirmation
          && this._strictTrusted.length >= 2) {
          this._strictSearching = true;
        }
        return {
          ...point,
          provisionalReacquisition: false,
          strictSearching: this._strictSearching,
        };
      }

      if (!this._plausible(point, snapshot)) {
        this._strictProvisional = [];
        return this._predictedMiss(input, snapshot, point, "flight-lock");
      }

      if (!this._strictSearching) return this._acceptTrusted(point);

      const candidateScore = point.candidateScore ?? point.confidence ?? 0;
      if (candidateScore < this._strictSettings.minimumReacquireScore) {
        this._strictProvisional = [];
        return this._predictedMiss(input, snapshot, point, "low-score");
      }

      if (!this._provisionalConsistent(point, input.fps || 30)) this._strictProvisional = [];
      this._strictProvisional.push({ ...point });
      if (this._strictProvisional.length < this._strictSettings.confirmationFrames) {
        return this._predictedMiss(input, snapshot, point, "confirming");
      }

      const first = pointXY(this._strictProvisional[0]);
      const last = pointXY(this._strictProvisional.at(-1));
      const dt = Math.max(1 / 300, last.time - first.time);
      const sequenceVelocity = { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
      this.velocity = {
        x: this.velocity.x * 0.35 + sequenceVelocity.x * 0.65,
        y: this.velocity.y * 0.35 + sequenceVelocity.y * 0.65,
      };
      this._strictSearching = false;
      this._strictConsecutiveMisses = 0;
      const confirmationFrames = this._strictProvisional.length;
      this._strictProvisional = [];
      return this._acceptTrusted({
        ...point,
        reacquisitionConfirmed: true,
        confirmationFrames,
        strictRejectedCount: this._strictRejected,
      });
    }
  }

  let trajectory = root.BallTraceTrajectory;
  if (trajectory?.buildPredictedTrajectory && trajectory.__strictReacquisitionVersion !== 2) {
    const originalBuild = trajectory.buildPredictedTrajectory;
    trajectory = Object.freeze({
      ...trajectory,
      buildPredictedTrajectory(input) {
        return originalBuild({
          ...input,
          points: flightLockedPoints(input?.points),
        });
      },
      flightLockedPoints,
      __strictReacquisitionVersion: 2,
    });
    root.BallTraceTrajectory = trajectory;
  }

  root.BallTraceAdaptive = Object.freeze({
    ...adaptive,
    AdaptiveSourceTracker: StrictAdaptiveTracker,
    flightLockedPoints,
    __strictReacquisitionVersion: 2,
  });
})(typeof self !== "undefined" ? self : globalThis);
