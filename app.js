(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const REACQUIRE_WINDOW_FRAMES = 18;
  const ui = {
    fileInput: $("#fileInput"),
    fileButtonText: $("#fileButtonText"),
    sourceVideo: $("#sourceVideo"),
    displayCanvas: $("#displayCanvas"),
    analysisCanvas: $("#analysisCanvas"),
    canvasWrap: $("#canvasWrap"),
    emptyState: $("#emptyState"),
    scrubber: $("#scrubber"),
    currentTime: $("#currentTime"),
    duration: $("#duration"),
    statusText: $("#statusText"),
    confidenceText: $("#confidenceText"),
    progress: $("#trackProgress"),
    trackButton: $("#trackButton"),
    resetButton: $("#resetButton"),
    exportButton: $("#exportButton"),
    shareButton: $("#shareButton"),
    playButton: $("#canvasPlayButton"),
    installButton: $("#installButton"),
    toast: $("#toast"),
  };

  const display = ui.displayCanvas.getContext("2d", { alpha: false });
  const analysis = ui.analysisCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const state = {
    url: null,
    selection: null,
    selectionTime: 0,
    selectionTemplate: null,
    points: [],
    predictedPoints: [],
    worker: null,
    busy: false,
    export: null,
    installPrompt: null,
  };

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

  function status(text, confidence = null) {
    ui.statusText.textContent = text;
    ui.confidenceText.textContent = confidence == null ? "" : `${Math.round(confidence * 100)}% confidence`;
  }

  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    setTimeout(() => { ui.toast.hidden = true; }, 2800);
  }

  function updateButtons() {
    ui.fileInput.disabled = state.busy;
    ui.scrubber.disabled = state.busy || !state.url;
    ui.trackButton.disabled = state.busy || !state.selection;
    ui.resetButton.disabled = state.busy || !state.selection;
    ui.exportButton.disabled = state.busy || state.points.filter((point) => point.state === "DETECTED").length < 2;
    ui.shareButton.disabled = ui.exportButton.disabled;
  }

  function waitForVideoEvent(eventNames, timeout = 10000) {
    if (ui.sourceVideo.error) return Promise.reject(new Error("Video could not be opened."));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        for (const eventName of eventNames) ui.sourceVideo.removeEventListener(eventName, done);
        ui.sourceVideo.removeEventListener("error", fail);
      };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error("Video could not be opened.")); };
      for (const eventName of eventNames) ui.sourceVideo.addEventListener(eventName, done, { once: true });
      ui.sourceVideo.addEventListener("error", fail, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("The video took too long to decode. Try selecting it again."));
      }, timeout);
    });
  }

  async function waitForMetadata() {
    if (ui.sourceVideo.readyState >= HTMLMediaElement.HAVE_METADATA && ui.sourceVideo.videoWidth) return;
    await waitForVideoEvent(["loadedmetadata"]);
  }

  async function waitForDecodedFrame() {
    if (ui.sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(["loadeddata", "canplay"]);
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof ui.sourceVideo.requestVideoFrameCallback === "function") {
        ui.sourceVideo.requestVideoFrameCallback(finish);
        setTimeout(finish, 350);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
    });
  }

  function configureCanvas() {
    const scale = Math.min(1, 900 / Math.max(ui.sourceVideo.videoWidth, ui.sourceVideo.videoHeight));
    const width = Math.max(1, Math.round(ui.sourceVideo.videoWidth * scale));
    const height = Math.max(1, Math.round(ui.sourceVideo.videoHeight * scale));
    for (const canvas of [ui.displayCanvas, ui.analysisCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }
    ui.canvasWrap.style.aspectRatio = `${width} / ${height}`;
  }

  function strokeTrace(points, options) {
    if (points.length < 2) return;
    display.save();
    display.strokeStyle = options.strokeStyle;
    display.lineWidth = options.lineWidth;
    display.lineCap = "round";
    display.lineJoin = "round";
    display.shadowColor = options.shadowColor;
    display.shadowBlur = options.shadowBlur;
    display.setLineDash(options.dash || []);
    display.beginPath();
    display.moveTo(points[0].smoothX, points[0].smoothY);
    for (let index = 1; index < points.length; index += 1) {
      display.lineTo(points[index].smoothX, points[index].smoothY);
    }
    display.stroke();
    display.restore();
  }

  function draw(time = ui.sourceVideo.currentTime, debug = true) {
    if (!state.url || ui.sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    try {
      display.drawImage(ui.sourceVideo, 0, 0, ui.displayCanvas.width, ui.displayCanvas.height);
    } catch {
      return false;
    }

    const detected = state.points.filter((point) => point.time <= time + 0.002 && point.state === "DETECTED");
    strokeTrace(detected, {
      strokeStyle: "#ff3b30",
      lineWidth: Math.max(3, ui.displayCanvas.width / 220),
      shadowColor: "rgba(255,59,48,.7)",
      shadowBlur: 8,
    });

    const estimated = state.predictedPoints.filter((point) => point.time <= time + 0.002);
    if (estimated.length) {
      const lastDetected = detected.at(-1) || state.points.filter((point) => point.state === "DETECTED").at(-1);
      strokeTrace(lastDetected ? [lastDetected, ...estimated] : estimated, {
        strokeStyle: "rgba(255,181,71,.9)",
        lineWidth: Math.max(3, ui.displayCanvas.width / 235),
        shadowColor: "rgba(255,181,71,.42)",
        shadowBlur: 6,
        dash: [11, 8],
      });
    }

    if (debug && state.selection && Math.abs(time - state.selectionTime) < 0.05) {
      display.save();
      display.strokeStyle = "#63e69c";
      display.lineWidth = 2;
      display.beginPath();
      display.arc(state.selection.x, state.selection.y, 12, 0, Math.PI * 2);
      display.stroke();
      display.restore();
    }

    ui.currentTime.textContent = formatTime(time);
    ui.scrubber.value = String(time);
    return true;
  }

  async function drawDecodedFrame() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForDecodedFrame();
      if (draw()) return;
      await sleep(80);
    }
    throw new Error("The video frame could not be displayed. Try selecting the video again.");
  }

  function seek(time, force = false) {
    return new Promise((resolve, reject) => {
      const maximum = Math.max(0, ui.sourceVideo.duration - 0.001);
      let safe = Math.max(0, Math.min(time, maximum));
      if (force && safe === 0 && maximum > 0) safe = Math.min(0.01, maximum);
      if (!force && Math.abs(ui.sourceVideo.currentTime - safe) < 0.0005
        && ui.sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error("Could not decode this frame.")); };
      const timer = setTimeout(fail, 6000);
      const cleanup = () => {
        clearTimeout(timer);
        ui.sourceVideo.removeEventListener("seeked", done);
        ui.sourceVideo.removeEventListener("error", fail);
      };
      ui.sourceVideo.addEventListener("seeked", done, { once: true });
      ui.sourceVideo.addEventListener("error", fail, { once: true });
      ui.sourceVideo.currentTime = safe;
    });
  }

  function captureFrame() {
    analysis.drawImage(ui.sourceVideo, 0, 0, ui.analysisCanvas.width, ui.analysisCanvas.height);
    return analysis.getImageData(0, 0, ui.analysisCanvas.width, ui.analysisCanvas.height).data;
  }

  async function loadVideo(file) {
    if (!file) return;
    state.busy = true;
    state.selection = null;
    state.selectionTemplate = null;
    state.points = [];
    state.predictedPoints = [];
    state.export = null;
    updateButtons();
    status("Loading video…");
    ui.emptyState.hidden = true;
    ui.canvasWrap.classList.remove("empty");
    ui.playButton.hidden = true;
    try {
      state.worker?.terminate();
      state.worker = null;
      ui.sourceVideo.pause();
      ui.sourceVideo.removeAttribute("src");
      ui.sourceVideo.load();
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(file);
      ui.sourceVideo.src = state.url;
      ui.sourceVideo.muted = true;
      ui.sourceVideo.load();
      await waitForMetadata();
      configureCanvas();
      ui.scrubber.max = String(ui.sourceVideo.duration);
      ui.duration.textContent = formatTime(ui.sourceVideo.duration);
      await seek(0, true);
      await drawDecodedFrame();
      ui.playButton.hidden = false;
      ui.fileButtonText.textContent = "Choose another video";
      status("Scrub to one or two frames before impact, then tap the ball.");
    } catch (error) {
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = null;
      ui.canvasWrap.classList.add("empty");
      ui.emptyState.hidden = false;
      ui.playButton.hidden = true;
      ui.fileButtonText.textContent = "Select video";
      status(error.message || "Video could not be loaded.");
      toast(error.message || "Video could not be loaded.");
    } finally {
      state.busy = false;
      ui.fileInput.value = "";
      updateButtons();
    }
  }

  function workerMessage(message, transfer = []) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tracker worker timed out.")), 15000);
      state.worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.type === "error") reject(new Error(event.data.message));
        else resolve(event.data);
      };
      state.worker.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Tracker worker failed."));
      };
      state.worker.postMessage(message, transfer);
    });
  }

  function presentOneFrame(timeout = 7000) {
    return new Promise((resolve, reject) => {
      let callbackId = null;
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        ui.sourceVideo.removeEventListener("ended", ended);
        ui.sourceVideo.removeEventListener("error", failed);
        if (callbackId != null && typeof ui.sourceVideo.cancelVideoFrameCallback === "function") {
          ui.sourceVideo.cancelVideoFrameCallback(callbackId);
        }
      };
      const finished = (metadata) => {
        ui.sourceVideo.pause();
        cleanup();
        resolve(metadata);
      };
      const ended = () => finished(null);
      const failed = () => {
        ui.sourceVideo.pause();
        cleanup();
        reject(new Error("Video decoding stopped during tracking."));
      };
      ui.sourceVideo.addEventListener("ended", ended, { once: true });
      ui.sourceVideo.addEventListener("error", failed, { once: true });
      callbackId = ui.sourceVideo.requestVideoFrameCallback((_, metadata) => finished(metadata));
      timer = setTimeout(() => {
        ui.sourceVideo.pause();
        cleanup();
        reject(new Error("The next video frame took too long to decode."));
      }, timeout);
      ui.sourceVideo.play().catch(failed);
    });
  }

  async function advanceToNextPresentedFrame(lastMediaTime, end) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const metadata = await presentOneFrame();
      if (!metadata) return null;
      const mediaTime = metadata.mediaTime ?? ui.sourceVideo.currentTime;
      if (mediaTime >= end) return { ...metadata, mediaTime: end };
      if (mediaTime > lastMediaTime + 0.0005) return { ...metadata, mediaTime };
    }
    throw new Error("Safari repeated the same decoded frame too many times.");
  }

  function updateTrackingProgress(point, end, processedFrames, searchFrames) {
    ui.progress.value = (point.time - state.selectionTime) / Math.max(0.01, end - state.selectionTime);
    if (searchFrames > 0) {
      status(`Ball hidden: searching the next ${REACQUIRE_WINDOW_FRAMES - searchFrames + 1}/${REACQUIRE_WINDOW_FRAMES} frames…`, point.confidence);
    } else {
      status(`Analysing frame ${processedFrames}: ${point.state.toLowerCase()}`, point.confidence);
    }
    draw(point.time);
  }

  function updateSearchState(point, searchState) {
    if (point.state === "DETECTED") {
      if (searchState.searchFrames > 0) searchState.reacquisitions += 1;
      searchState.searchFrames = 0;
      return;
    }
    if (point.launched || searchState.searchFrames > 0) searchState.searchFrames += 1;
  }

  async function trackPresentedFrames(end) {
    let lastMediaTime = state.selectionTime;
    let lastPresentedFrames = null;
    let processedFrames = 0;
    let skippedFrames = 0;
    const searchState = { searchFrames: 0, reacquisitions: 0 };
    const originalRate = ui.sourceVideo.playbackRate;
    ui.sourceVideo.playbackRate = 0.5;
    ui.sourceVideo.muted = true;
    try {
      while (!ui.sourceVideo.ended && lastMediaTime < end - 0.001
        && searchState.searchFrames < REACQUIRE_WINDOW_FRAMES) {
        const metadata = await advanceToNextPresentedFrame(lastMediaTime, end);
        if (!metadata) break;
        const mediaTime = metadata.mediaTime;
        if (lastPresentedFrames != null && metadata.presentedFrames > lastPresentedFrames + 1) {
          skippedFrames += metadata.presentedFrames - lastPresentedFrames - 1;
        }
        lastPresentedFrames = metadata.presentedFrames;
        const frame = captureFrame();
        const reply = await workerMessage({ type: "frame", frame: frame.buffer, time: mediaTime }, [frame.buffer]);
        state.points.push(reply.point);
        lastMediaTime = mediaTime;
        processedFrames += 1;
        updateSearchState(reply.point, searchState);
        updateTrackingProgress(reply.point, end, processedFrames, searchState.searchFrames);
      }
    } finally {
      ui.sourceVideo.pause();
      ui.sourceVideo.playbackRate = originalRate;
    }
    return {
      lost: searchState.searchFrames >= REACQUIRE_WINDOW_FRAMES,
      processedFrames,
      skippedFrames,
      reacquisitions: searchState.reacquisitions,
    };
  }

  async function trackThirtyFpsFallback(end) {
    let time = state.selectionTime;
    let processedFrames = 0;
    const searchState = { searchFrames: 0, reacquisitions: 0 };
    while (time < end && searchState.searchFrames < REACQUIRE_WINDOW_FRAMES) {
      time = Math.min(end, time + 1 / 30);
      await seek(time);
      await waitForDecodedFrame();
      const frame = captureFrame();
      const reply = await workerMessage({ type: "frame", frame: frame.buffer, time }, [frame.buffer]);
      state.points.push(reply.point);
      processedFrames += 1;
      updateSearchState(reply.point, searchState);
      updateTrackingProgress(reply.point, end, processedFrames, searchState.searchFrames);
    }
    return {
      lost: searchState.searchFrames >= REACQUIRE_WINDOW_FRAMES,
      processedFrames,
      skippedFrames: 0,
      reacquisitions: searchState.reacquisitions,
    };
  }

  function createPrediction() {
    state.predictedPoints = globalThis.BallTraceTrajectory.buildPredictedTrajectory({
      points: state.points,
      width: ui.analysisCanvas.width,
      height: ui.analysisCanvas.height,
      videoEndTime: ui.sourceVideo.duration,
      fps: 30,
      maxSeconds: 5.5,
    });
    return state.predictedPoints;
  }

  async function trackBall() {
    if (!state.selection) return;
    state.busy = true;
    state.points = [];
    state.predictedPoints = [];
    state.export = null;
    updateButtons();
    ui.progress.hidden = false;
    ui.progress.value = 0;
    try {
      ui.sourceVideo.pause();
      state.worker?.terminate();
      state.worker = new Worker("/tracker.worker.js");
      await seek(state.selectionTime);
      await waitForDecodedFrame();
      const frame = captureFrame();
      const initial = await workerMessage({
        type: "init",
        frame: frame.buffer,
        width: ui.analysisCanvas.width,
        height: ui.analysisCanvas.height,
        x: state.selection.x,
        y: state.selection.y,
        time: state.selectionTime,
        template: state.selectionTemplate,
      }, [frame.buffer]);
      state.points.push(initial.point);
      const end = Math.min(ui.sourceVideo.duration, state.selectionTime + 8);
      status(`Tracking ${initial.point.templateClass || "selected"} ball frame by frame…`);
      const result = typeof ui.sourceVideo.requestVideoFrameCallback === "function"
        ? await trackPresentedFrames(end)
        : await trackThirtyFpsFallback(end);
      const prediction = createPrediction();
      const detectedFrames = state.points.filter((point) => point.state === "DETECTED").length;
      await seek(state.selectionTime);
      await drawDecodedFrame();
      if (prediction.length) {
        const reacquired = result.reacquisitions ? `, reacquired ${result.reacquisitions} time${result.reacquisitions === 1 ? "" : "s"}` : "";
        status(`Tracked ${detectedFrames} real frames${reacquired}. Solid red is tracked; dashed gold is the rough continuation.`);
      } else if (result.skippedFrames > 0) {
        status(`Tracked ${detectedFrames} real frames. Safari skipped ${result.skippedFrames} frame${result.skippedFrames === 1 ? "" : "s"}; no safe continuation was added.`);
      } else {
        status(`Tracked ${detectedFrames} real frames. There was not enough reliable motion to predict the rest.`);
      }
    } catch (error) {
      status(error.message || "Tracking failed.");
      toast(error.message || "Tracking failed.");
    } finally {
      state.busy = false;
      ui.progress.hidden = true;
      updateButtons();
    }
  }

  function resetPoint() {
    state.selection = null;
    state.selectionTemplate = null;
    state.points = [];
    state.predictedPoints = [];
    state.export = null;
    draw();
    status("Tap the ball again on the current frame.");
    updateButtons();
  }

  function traceEndTime() {
    return Math.min(ui.sourceVideo.duration, Math.max(
      state.points.filter((point) => point.state === "DETECTED").at(-1)?.time || state.selectionTime,
      state.predictedPoints.at(-1)?.time || state.selectionTime,
    ));
  }

  async function createExport() {
    if (state.points.filter((point) => point.state === "DETECTED").length < 2) return null;
    state.busy = true;
    updateButtons();
    status("Rendering export in real time…");
    try {
      const mimeCandidates = ["video/mp4;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
      const mime = typeof MediaRecorder !== "undefined"
        ? mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type))
        : null;
      if (!mime || !ui.displayCanvas.captureStream) {
        await seek(traceEndTime());
        draw(traceEndTime(), false);
        const blob = await new Promise((resolve) => ui.displayCanvas.toBlob(resolve, "image/png"));
        state.export = { blob, name: "balltrace.png" };
        return state.export;
      }
      await seek(state.selectionTime);
      const stream = ui.displayCanvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = reject;
      });
      recorder.start(250);
      ui.sourceVideo.muted = true;
      await ui.sourceVideo.play();
      const end = traceEndTime();
      await new Promise((resolve) => {
        const tick = () => {
          draw(ui.sourceVideo.currentTime, false);
          if (ui.sourceVideo.currentTime >= end || ui.sourceVideo.ended) {
            ui.sourceVideo.pause();
            resolve();
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const extension = mime.includes("mp4") ? "mp4" : "webm";
      state.export = { blob: new Blob(chunks, { type: mime }), name: `balltrace.${extension}` };
      return state.export;
    } finally {
      state.busy = false;
      await seek(state.selectionTime);
      await drawDecodedFrame();
      updateButtons();
      status("Export ready. Solid red is tracked; dashed gold is estimated.");
    }
  }

  function download(result) {
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportFile() {
    const result = state.export || await createExport();
    if (result) download(result);
  }

  async function shareFile() {
    const result = state.export || await createExport();
    if (!result) return;
    const file = new File([result.blob], result.name, { type: result.blob.type });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: "BallTrace", files: [file] });
    } else {
      download(result);
      toast("Sharing is unavailable, so the file was downloaded.");
    }
  }

  ui.fileInput.addEventListener("change", (event) => {
    loadVideo(event.target.files?.[0]).catch((error) => status(error.message));
  });
  ui.scrubber.addEventListener("input", async () => {
    ui.sourceVideo.pause();
    await seek(Number(ui.scrubber.value));
    await drawDecodedFrame();
  });
  ui.displayCanvas.addEventListener("pointerup", (event) => {
    if (!state.url || state.busy) return;
    event.preventDefault();
    const rect = ui.displayCanvas.getBoundingClientRect();
    state.selection = {
      x: (event.clientX - rect.left) * ui.displayCanvas.width / rect.width,
      y: (event.clientY - rect.top) * ui.displayCanvas.height / rect.height,
    };
    state.selectionTime = ui.sourceVideo.currentTime;
    state.points = [];
    state.predictedPoints = [];
    state.export = null;
    const selectedFrame = captureFrame();
    state.selectionTemplate = globalThis.BallTraceCore.samplePatch(
      selectedFrame,
      ui.analysisCanvas.width,
      ui.analysisCanvas.height,
      state.selection.x,
      state.selection.y,
    );
    draw();
    const selectedClass = state.selectionTemplate.className;
    if (selectedClass === "yellow" || selectedClass === "white") {
      status(`${selectedClass[0].toUpperCase()}${selectedClass.slice(1)} ball selected. Press Track ball.`);
    } else {
      status("Selection is not clearly white or yellow. Tap the centre again, or press Track ball to try.");
    }
    updateButtons();
  });

  ui.trackButton.addEventListener("click", trackBall);
  ui.resetButton.addEventListener("click", resetPoint);
  ui.exportButton.addEventListener("click", exportFile);
  ui.shareButton.addEventListener("click", shareFile);
  ui.playButton.addEventListener("click", async () => {
    if (ui.sourceVideo.paused) {
      await ui.sourceVideo.play();
      ui.playButton.textContent = "Ⅱ";
      const loop = () => {
        draw();
        if (!ui.sourceVideo.paused) requestAnimationFrame(loop);
        else ui.playButton.textContent = "▶";
      };
      loop();
    } else {
      ui.sourceVideo.pause();
      ui.playButton.textContent = "▶";
    }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    ui.installButton.hidden = false;
  });
  ui.installButton.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    state.installPrompt = null;
    ui.installButton.hidden = true;
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
  }
  updateButtons();
})();
