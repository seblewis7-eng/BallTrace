(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    fileInput: $("#fileInput"), sourceVideo: $("#sourceVideo"), displayCanvas: $("#displayCanvas"),
    analysisCanvas: $("#analysisCanvas"), canvasWrap: $("#canvasWrap"), emptyState: $("#emptyState"),
    scrubber: $("#scrubber"), currentTime: $("#currentTime"), duration: $("#duration"),
    statusText: $("#statusText"), confidenceText: $("#confidenceText"), progress: $("#trackProgress"),
    trackButton: $("#trackButton"), resetButton: $("#resetButton"), exportButton: $("#exportButton"),
    shareButton: $("#shareButton"), playButton: $("#canvasPlayButton"), installButton: $("#installButton"), toast: $("#toast"),
  };
  const display = ui.displayCanvas.getContext("2d", { alpha: false });
  const analysis = ui.analysisCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const state = { url: null, selection: null, selectionTime: 0, points: [], worker: null, busy: false, export: null, installPrompt: null };
  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
  const status = (text, confidence = null) => {
    ui.statusText.textContent = text;
    ui.confidenceText.textContent = confidence == null ? "" : `${Math.round(confidence * 100)}% confidence`;
  };
  const toast = (text) => { ui.toast.textContent = text; ui.toast.hidden = false; setTimeout(() => { ui.toast.hidden = true; }, 2800); };
  function updateButtons() {
    ui.scrubber.disabled = state.busy || !state.url;
    ui.trackButton.disabled = state.busy || !state.selection;
    ui.resetButton.disabled = state.busy || !state.selection;
    ui.exportButton.disabled = state.busy || state.points.length < 2;
    ui.shareButton.disabled = state.busy || state.points.length < 2;
  }
  function configureCanvas() {
    const scale = Math.min(1, 720 / Math.max(ui.sourceVideo.videoWidth, ui.sourceVideo.videoHeight));
    const width = Math.max(1, Math.round(ui.sourceVideo.videoWidth * scale));
    const height = Math.max(1, Math.round(ui.sourceVideo.videoHeight * scale));
    for (const canvas of [ui.displayCanvas, ui.analysisCanvas]) { canvas.width = width; canvas.height = height; }
    ui.canvasWrap.style.aspectRatio = `${width} / ${height}`;
  }
  function draw(time = ui.sourceVideo.currentTime, debug = true) {
    if (!state.url || ui.sourceVideo.readyState < 2) return;
    display.drawImage(ui.sourceVideo, 0, 0, ui.displayCanvas.width, ui.displayCanvas.height);
    const visible = state.points.filter((point) => point.time <= time + 0.002 && point.state !== "LOST");
    if (visible.length > 1) {
      display.save(); display.strokeStyle = "#ff3b30"; display.lineWidth = Math.max(3, ui.displayCanvas.width / 220);
      display.lineCap = "round"; display.lineJoin = "round"; display.shadowColor = "rgba(255,59,48,.7)"; display.shadowBlur = 8;
      display.beginPath(); display.moveTo(visible[0].smoothX, visible[0].smoothY);
      for (let i = 1; i < visible.length; i += 1) display.lineTo(visible[i].smoothX, visible[i].smoothY);
      display.stroke(); display.restore();
    }
    if (debug && state.selection && Math.abs(time - state.selectionTime) < 0.05) {
      display.save(); display.strokeStyle = "#63e69c"; display.lineWidth = 2; display.beginPath();
      display.arc(state.selection.x, state.selection.y, 12, 0, Math.PI * 2); display.stroke(); display.restore();
    }
    ui.currentTime.textContent = formatTime(time); ui.scrubber.value = String(time);
  }
  function seek(time) {
    return new Promise((resolve, reject) => {
      const safe = Math.max(0, Math.min(time, Math.max(0, ui.sourceVideo.duration - 0.001)));
      if (Math.abs(ui.sourceVideo.currentTime - safe) < 0.0005 && ui.sourceVideo.readyState >= 2) return resolve();
      const done = () => { cleanup(); resolve(); }; const fail = () => { cleanup(); reject(new Error("Could not decode this frame.")); };
      const timer = setTimeout(fail, 5000);
      const cleanup = () => { clearTimeout(timer); ui.sourceVideo.removeEventListener("seeked", done); ui.sourceVideo.removeEventListener("error", fail); };
      ui.sourceVideo.addEventListener("seeked", done, { once: true }); ui.sourceVideo.addEventListener("error", fail, { once: true }); ui.sourceVideo.currentTime = safe;
    });
  }
  function captureFrame() {
    analysis.drawImage(ui.sourceVideo, 0, 0, ui.analysisCanvas.width, ui.analysisCanvas.height);
    return analysis.getImageData(0, 0, ui.analysisCanvas.width, ui.analysisCanvas.height).data;
  }
  async function loadVideo(file) {
    if (!file) return;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(file); state.selection = null; state.points = []; state.export = null;
    ui.sourceVideo.src = state.url; ui.sourceVideo.load();
    await new Promise((resolve, reject) => { ui.sourceVideo.addEventListener("loadedmetadata", resolve, { once: true }); ui.sourceVideo.addEventListener("error", () => reject(new Error("Video could not be opened.")), { once: true }); });
    configureCanvas(); ui.scrubber.max = String(ui.sourceVideo.duration); ui.duration.textContent = formatTime(ui.sourceVideo.duration);
    ui.canvasWrap.classList.remove("empty"); ui.emptyState.hidden = true; ui.playButton.hidden = false;
    await seek(0); draw(); status("Scrub to before impact, then tap the ball."); updateButtons();
  }
  function workerMessage(message, transfer = []) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tracker worker timed out.")), 7000);
      state.worker.onmessage = (event) => { clearTimeout(timeout); event.data.type === "error" ? reject(new Error(event.data.message)) : resolve(event.data); };
      state.worker.onerror = () => { clearTimeout(timeout); reject(new Error("Tracker worker failed.")); };
      state.worker.postMessage(message, transfer);
    });
  }
  async function trackBall() {
    if (!state.selection) return;
    state.busy = true; state.points = []; state.export = null; updateButtons(); ui.progress.hidden = false; ui.progress.value = 0;
    try {
      ui.sourceVideo.pause(); state.worker?.terminate(); state.worker = new Worker("/tracker.worker.js");
      await seek(state.selectionTime); let frame = captureFrame();
      let reply = await workerMessage({ type: "init", frame: frame.buffer, width: ui.analysisCanvas.width, height: ui.analysisCanvas.height, x: state.selection.x, y: state.selection.y, time: state.selectionTime }, [frame.buffer]);
      state.points.push(reply.point);
      const end = Math.min(ui.sourceVideo.duration, state.selectionTime + 8);
      let time = state.selectionTime; let lost = false;
      while (time < end && !lost) {
        const elapsed = time - state.selectionTime; time = Math.min(end, time + (elapsed < 0.75 ? 1 / 60 : 1 / 30));
        await seek(time); frame = captureFrame(); reply = await workerMessage({ type: "frame", frame: frame.buffer, time }, [frame.buffer]);
        state.points.push(reply.point); lost = reply.point.state === "LOST";
        ui.progress.value = (time - state.selectionTime) / Math.max(0.01, end - state.selectionTime);
        status(reply.point.state === "LOST" ? "Track lost. Preview uses detections up to that point." : `Tracking: ${reply.point.state.toLowerCase()}`, reply.point.confidence);
        if (state.points.length % 3 === 0) draw(time);
      }
      await seek(state.selectionTime); draw(); status(lost ? "Tracking complete: ball lost after the final reliable point." : "Tracking complete.");
    } catch (error) { status(error.message || "Tracking failed."); toast(error.message || "Tracking failed."); }
    finally { state.busy = false; ui.progress.hidden = true; updateButtons(); }
  }
  function resetPoint() { state.selection = null; state.points = []; state.export = null; draw(); status("Tap the ball again on the current frame."); updateButtons(); }
  async function createExport() {
    if (state.points.length < 2) return null;
    state.busy = true; updateButtons(); status("Rendering export in real time…");
    try {
      const mimeCandidates = ["video/mp4;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
      const mime = typeof MediaRecorder !== "undefined" ? mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) : null;
      if (!mime || !ui.displayCanvas.captureStream) {
        await seek(state.points.at(-1).time); draw(state.points.at(-1).time, false);
        const blob = await new Promise((resolve) => ui.displayCanvas.toBlob(resolve, "image/png"));
        state.export = { blob, name: "balltrace.png" }; return state.export;
      }
      await seek(state.selectionTime); const stream = ui.displayCanvas.captureStream(30); const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
      const chunks = []; recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; }); recorder.start(250);
      ui.sourceVideo.muted = true; await ui.sourceVideo.play();
      await new Promise((resolve) => { const tick = () => { draw(ui.sourceVideo.currentTime, false); if (ui.sourceVideo.currentTime >= state.points.at(-1).time || ui.sourceVideo.ended) { ui.sourceVideo.pause(); resolve(); } else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
      recorder.stop(); await stopped; stream.getTracks().forEach((track) => track.stop());
      const extension = mime.includes("mp4") ? "mp4" : "webm"; state.export = { blob: new Blob(chunks, { type: mime }), name: `balltrace.${extension}` }; return state.export;
    } finally { state.busy = false; await seek(state.selectionTime); draw(); updateButtons(); status("Export ready."); }
  }
  function download(result) { const url = URL.createObjectURL(result.blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function exportFile() { const result = state.export || await createExport(); if (result) download(result); }
  async function shareFile() {
    const result = state.export || await createExport(); if (!result) return;
    const file = new File([result.blob], result.name, { type: result.blob.type });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) await navigator.share({ title: "BallTrace", files: [file] });
    else { download(result); toast("Sharing is unavailable, so the file was downloaded."); }
  }
  ui.fileInput.addEventListener("change", (event) => loadVideo(event.target.files?.[0]).catch((error) => status(error.message)));
  ui.scrubber.addEventListener("input", async () => { ui.sourceVideo.pause(); await seek(Number(ui.scrubber.value)); draw(); });
  ui.displayCanvas.addEventListener("pointerup", (event) => {
    if (!state.url || state.busy) return; const rect = ui.displayCanvas.getBoundingClientRect();
    state.selection = { x: (event.clientX - rect.left) * ui.displayCanvas.width / rect.width, y: (event.clientY - rect.top) * ui.displayCanvas.height / rect.height };
    state.selectionTime = ui.sourceVideo.currentTime; state.points = []; state.export = null; draw(); status("Ball selected. Press Track ball."); updateButtons();
  });
  ui.trackButton.addEventListener("click", trackBall); ui.resetButton.addEventListener("click", resetPoint); ui.exportButton.addEventListener("click", exportFile); ui.shareButton.addEventListener("click", shareFile);
  ui.playButton.addEventListener("click", async () => { if (ui.sourceVideo.paused) { await ui.sourceVideo.play(); const loop = () => { draw(); if (!ui.sourceVideo.paused) requestAnimationFrame(loop); }; loop(); } else ui.sourceVideo.pause(); });
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.installPrompt = event; ui.installButton.hidden = false; });
  ui.installButton.addEventListener("click", async () => { if (state.installPrompt) { await state.installPrompt.prompt(); state.installPrompt = null; ui.installButton.hidden = true; } });
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
  updateButtons();
})();
