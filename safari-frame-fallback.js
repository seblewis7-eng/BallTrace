(function installSafariFrameFallback(root) {
  "use strict";

  const prototype = root.HTMLVideoElement?.prototype;
  if (!prototype?.requestVideoFrameCallback || prototype.__ballTraceFrameFallback) return;

  const nativeRequest = prototype.requestVideoFrameCallback;
  const nativeCancel = prototype.cancelVideoFrameCallback;
  const callbacks = new WeakMap();
  const counters = new WeakMap();
  let nextToken = 1;

  function nextPresentedFrame(video) {
    const current = counters.get(video) || 0;
    counters.set(video, current + 1);
    return current + 1;
  }

  prototype.requestVideoFrameCallback = function requestVideoFrameCallback(callback) {
    const video = this;
    const token = nextToken++;
    let settled = false;
    let nativeId = null;
    let timer = null;

    const finish = (now, metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callbacks.delete(video);
      callback(now, {
        mediaTime: Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : video.currentTime,
        presentedFrames: Number.isFinite(metadata?.presentedFrames)
          ? metadata.presentedFrames
          : nextPresentedFrame(video),
        expectedDisplayTime: metadata?.expectedDisplayTime ?? now,
        width: metadata?.width ?? video.videoWidth,
        height: metadata?.height ?? video.videoHeight,
      });
    };

    nativeId = nativeRequest.call(video, finish);
    timer = setTimeout(() => {
      if (settled) return;
      video.pause();
      const maximum = Number.isFinite(video.duration)
        ? Math.max(0, video.duration - 0.001)
        : video.currentTime;
      const measuredDuration = Number.isFinite(video.__ballTraceFrameDuration)
        ? video.__ballTraceFrameDuration
        : 1 / 30;
      const frameDuration = Math.max(1 / 240, Math.min(1 / 12, measuredDuration));
      const target = Math.min(maximum, video.currentTime + frameDuration);
      if (target > video.currentTime + 0.0005) {
        const onSeeked = () => finish(performance.now(), {
          mediaTime: video.currentTime,
          presentedFrames: nextPresentedFrame(video),
        });
        video.addEventListener("seeked", onSeeked, { once: true });
        video.currentTime = target;
        setTimeout(() => {
          video.removeEventListener("seeked", onSeeked);
          finish(performance.now(), {
            mediaTime: video.currentTime,
            presentedFrames: nextPresentedFrame(video),
          });
        }, 700);
      } else {
        finish(performance.now(), {
          mediaTime: video.currentTime,
          presentedFrames: nextPresentedFrame(video),
        });
      }
    }, 1400);

    callbacks.set(video, { token, nativeId, timer });
    return token;
  };

  prototype.cancelVideoFrameCallback = function cancelVideoFrameCallback(token) {
    const active = callbacks.get(this);
    if (!active || active.token !== token) {
      if (nativeCancel && Number.isInteger(token)) nativeCancel.call(this, token);
      return;
    }
    clearTimeout(active.timer);
    callbacks.delete(this);
    if (nativeCancel && active.nativeId != null) nativeCancel.call(this, active.nativeId);
  };

  Object.defineProperty(prototype, "__ballTraceFrameFallback", {
    value: true,
    configurable: false,
  });
})(typeof window !== "undefined" ? window : globalThis);
