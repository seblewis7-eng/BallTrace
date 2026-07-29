(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
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
    points: [],
    worker: null,
    busy: false,
    export: null,
    installPrompt: null,
  };

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

  const status = (text, confidence = null) => {
    ui.statusText.textContent = text;
    ui.confidenceText.textContent = confidence == null ? "" : `${Math.round(confidence * 100)}% confidence`;
  };

  const toast = (text) => {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    setTimeout(() => {
      ui.toast.hidden = true;
    }, 2800);
  };

  function updateButtons() {
    ui.fileInput.disabled = state.busy;
    ui.scrubber.disabled = state.busy || !state.url;
    ui.trackButton.disabled = state.busy || !state.selection;
    ui.resetButton.disabled = state.busy || !state.selection;
    ui.exportButton.disabled = state.busy || state.points.length < 2;
    ui.shareButton.disabled = state.busy || state.points.length < 2;
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
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Video could not be opened."));
      };
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
    const scale = Math.min(1, 720 / Math.max(ui.sourceVideo.videoWidth, ui.sourceVideo.videoHeight));
    const width = Math.max(1, Math.round(ui.sourceVideo.videoWidth * scale));
    const height = Math.max(1, Math.round(ui.sourceVideo.videoHeight * scale));
    for (const canvas of [ui.displayCanvas, ui.analysisCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }
    ui.canvasWrap.style.aspectRatio = `${width} / ${height}`;
  }

  function draw(time = ui.sourceVideo.currentTime, debug = true) {
    if (!state.url || ui.sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    try {
      display.drawImage(ui.sourceVideo, 0, 0, ui.displayCanvas.width, ui.displayCanvas.height);
    } catch {
      return false;
    }

    const visible = state.points.filter((point) => point.time <= time + 0.002 && point.state !== "LOST");
    if (visible.length > 1) {
      display.save();
      display.strokeStyle = "#ff3b30";
      display.lineWidth = Math.max(3, ui.displayCanvas.width / 220);
      display.lineCap = "round";
      display.lineJoin = "round";
      display.shadowColor = "rgba(255,59,48,.7)";
      display.shadowBlur = 8;
      display.beginPath();
      display.moveTo(visible[0].smoothX, visible[0].smoothY);
      for (let index = 1; index < visible.length; index += 1) display.lineTo(visible[index].smoothX, visible[index].smoothY);
      display.stroke();
      display.restore();
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
    throw new Error("The first video frame could not be displayed. Try selecting the video again.");
  }

  function seek(time, force = false) {
    return new Promise((resolve, reject) => {
      const maximum = Math.max(0, ui.sourceVideo.duration - 0.001);
      let safe = Math.max(0, Math.min(time, maximum));
      if (force && safe === 0 && maximum > 0) safe = Math.min(0.01, maximum);
      if (!force && Math.abs(ui.sourceVideo.currentTime - safe) < 0.0005 && ui.sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }

      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Could not decode this frame."));
      };
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
    state.points = [];
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
      status("Scrub to before impact, then tap the ball.");
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
      const timeout = setTimeout(() => reject(new Error("Tracker worker timed out.")), 7000);
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

  async function trackBall() {
    if (!state.selection) return;
    state.busy = true;
    state.points = [];
    state.export = null;
    updateButtons();
    ui.progress.hidden = false;
    ui.progress.value = 0;

    try {
      ui.sourceVideo.pause();
      state.worker?.terminate();
      state.worker = new Worker("/tracker.worker.js");
      await seek(state.selectionTime);
      let frame = captureFrame();
      let reply = await workerMessage({
        type: "init",
        frame: frame.buffer,
        width: ui.analysisCanvas.width,
        height: ui.analysisCanvas.height,
        x: state.selection.x,
        y: state.selection.y,
        time: state.selectionTime,
      }, [frame.buffer]);
      state.points.push(reply.point);

      const end = Math.min(ui.sourceVideo.duration, state.selectionTime + 8);
      let time = state.selectionTime;
      let lost = false;
      while (time < end && !lost) {
        const elapsed = time - state.selectionTime;
        time = Math.min(end, time + (elapsed < 0.75 ? 1 / 60 : 1 / 30));
        await seek(time);
        frame = captureFrame();
        reply = await workerMessage({ type: "frame", frame: frame.buffer, time }, [frame.buffer]);
        state.points.push(reply.point);
        lost = reply.point.state === "LOST";
        ui.progress.value = (time - state.selectionTime) / Math.max(0.01, end - state.selectionTime);
        status(reply.point.state === "LOST" ? "Track lost. Preview uses detections up to that point." : `Tracking: ${reply.point.state.toLowerCase()}`, reply.point.confidence);
        if (state.points.length % 3 === 0) draw(time);
      }
      await seek(state.selectionTime);
      await drawDecodedFrame();
      status(lost ? "Tracking complete: ball lost after the final reliable point." : "Tracking complete.");
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
    state.points = [];
    state.export = null;
    draw();
    status("Tap the ball again on the current frame.");
    updateButtons();
  }

  async function createExport() {
    if (state.points.length < 2) return null;
    state.busy = true;
    updateButtons();
    status("Rendering export in real time…");
    try {
      const mimeCandidates = ["video/mp4;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
      const mime = typeof MediaRecorder !== "undefined" ? mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) : null;
      if (!mime || !ui.displayCanvas.captureStream) {
        await seek(state.points.at(-1).time);
        draw(state.points.at(-1).time, false);
        const blob = await new Promise((resolve) => ui.displayCanvas.toBlob(resolve, "image/png"));
        state.export = { blob, name: "balltrace.png" };
        return state.export;
      }

      await seek(state.selectionTime);
      const stream = ui.displayCanvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = reject;
      });
      recorder.start(250);
      ui.sourceVideo.muted = true;
      await ui.sourceVideo.play();
      await new Promise((resolve) => {
        const tick = () => {
          draw(ui.sourceVideo.currentTime, false);
          if (ui.sourceVideo.currentTime >= state.points.at(-1).time || ui.sourceVideo.ended) {
            ui.sourceVideo.pause();
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
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
      status("Export ready.");
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
    const file = event.target.files?.[0];
    loadVideo(file).catch((error) => status(error.message));
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
    state.export = null;
    draw();
    status("Ball selected. Press Track ball.");
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
