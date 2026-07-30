(function attachBallTraceTrajectory(root) {
  "use strict";

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function reliablePoints(points) {
    return points.filter((point) => point
      && point.state === "DETECTED"
      && Number.isFinite(point.time)
      && Number.isFinite(point.smoothX ?? point.x)
      && Number.isFinite(point.smoothY ?? point.y));
  }

  function linearVelocity(points, axis) {
    if (points.length < 2) return 0;
    const origin = points[0].time;
    let sumT = 0;
    let sumV = 0;
    let sumTT = 0;
    let sumTV = 0;
    for (const point of points) {
      const time = point.time - origin;
      const value = axis === "x" ? (point.smoothX ?? point.x) : (point.smoothY ?? point.y);
      sumT += time;
      sumV += value;
      sumTT += time * time;
      sumTV += time * value;
    }
    const count = points.length;
    const denominator = count * sumTT - sumT * sumT;
    if (Math.abs(denominator) < 1e-8) return 0;
    return (count * sumTV - sumT * sumV) / denominator;
  }

  function estimateMotion(points, width, height) {
    const detected = reliablePoints(points);
    if (detected.length < 4) return null;
    const recent = detected.slice(-Math.min(8, detected.length));
    const first = detected[0];
    const last = detected.at(-1);
    const elapsed = Math.max(1 / 120, last.time - first.time);
    const displacement = Math.hypot(
      (last.smoothX ?? last.x) - (first.smoothX ?? first.x),
      (last.smoothY ?? last.y) - (first.smoothY ?? first.y),
    );
    if (elapsed < 0.08 || displacement < Math.max(8, Math.min(width, height) * 0.015)) return null;

    let vx = linearVelocity(recent, "x");
    let vy = linearVelocity(recent, "y");
    const overallVx = ((last.smoothX ?? last.x) - (first.smoothX ?? first.x)) / elapsed;
    const overallVy = ((last.smoothY ?? last.y) - (first.smoothY ?? first.y)) / elapsed;
    vx = vx * 0.62 + overallVx * 0.38;
    vy = vy * 0.62 + overallVy * 0.38;

    vx = clamp(vx, -width * 1.25, width * 1.25);
    vy = clamp(vy, -height * 0.52, height * 0.22);
    if (vy > -height * 0.045) vy = -height * 0.09;

    return {
      detected,
      first,
      last,
      vx,
      vy,
      elapsed,
      displacement,
    };
  }

  function buildPredictedTrajectory({
    points,
    width,
    height,
    videoEndTime,
    fps = 30,
    maxSeconds = 5.5,
  }) {
    if (!Array.isArray(points) || !Number.isFinite(width) || !Number.isFinite(height)) return [];
    const motion = estimateMotion(points, width, height);
    if (!motion) return [];

    const lastX = motion.last.smoothX ?? motion.last.x;
    const lastY = motion.last.smoothY ?? motion.last.y;
    const firstY = motion.first.smoothY ?? motion.first.y;
    const available = Number.isFinite(videoEndTime)
      ? Math.max(0, videoEndTime - motion.last.time)
      : maxSeconds;
    if (available < 0.2) return [];

    const landingY = clamp(
      Math.max(height * 0.5, Math.min(height * 0.72, firstY - height * 0.08)),
      height * 0.46,
      height * 0.74,
    );
    const gravity = height * 0.34;
    const discriminant = Math.max(0, motion.vy * motion.vy + 2 * gravity * (landingY - lastY));
    const naturalDuration = (-motion.vy + Math.sqrt(discriminant)) / gravity;
    const intendedDuration = clamp(naturalDuration || maxSeconds, 0.8, maxSeconds);
    const duration = Math.min(available, intendedDuration);
    const frameCount = Math.max(2, Math.floor(duration * clamp(fps, 12, 60)));
    const horizontalDamping = clamp(0.72 + Math.abs(motion.vx) / Math.max(1, width) * 0.55, 0.72, 1.35);

    const predicted = [];
    for (let index = 1; index <= frameCount; index += 1) {
      const elapsed = duration * index / frameCount;
      const time = motion.last.time + elapsed;
      const dampingTravel = motion.vx * horizontalDamping * (1 - Math.exp(-elapsed / horizontalDamping));
      const x = lastX + dampingTravel;
      const y = lastY + motion.vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const progress = index / frameCount;
      if (x < -width * 0.08 || x > width * 1.08 || y < -height * 0.08 || y > height * 0.86) break;
      predicted.push({
        state: "ESTIMATED",
        x,
        y,
        smoothX: x,
        smoothY: y,
        time,
        confidence: 0.46 * (1 - progress) + 0.08,
        estimated: true,
      });
    }
    return predicted;
  }

  root.BallTraceTrajectory = Object.freeze({
    buildPredictedTrajectory,
    estimateMotion,
    linearVelocity,
    reliablePoints,
  });
})(typeof self !== "undefined" ? self : globalThis);
