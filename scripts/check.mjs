import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "dist", "node_modules"]);
async function walk(directory) { const entries = await readdir(directory, { withFileTypes: true }); const files = []; for (const entry of entries) { if (ignored.has(entry.name)) continue; const full = path.join(directory, entry.name); if (entry.isDirectory()) files.push(...await walk(full)); else files.push(full); } return files; }
const mode = process.argv[2] || "--lint";
const files = await walk(root);
const scripts = files.filter((file) => /\.(?:js|mjs)$/.test(file));
const errors = [];
for (const file of scripts) { const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }); if (result.status !== 0) errors.push(`${path.relative(root, file)} has invalid JavaScript: ${result.stderr.trim()}`); }
if (mode === "--typecheck") {
  const [html, app, worker, core, trajectory, guard, frameFallback, adaptive] = await Promise.all([readFile(path.join(root, "index.html"), "utf8"), readFile(path.join(root, "app.js"), "utf8"), readFile(path.join(root, "tracker.worker.js"), "utf8"), readFile(path.join(root, "tracker-core.js"), "utf8"), readFile(path.join(root, "trajectory.js"), "utf8"), readFile(path.join(root, "tracking-guard.js"), "utf8"), readFile(path.join(root, "safari-frame-fallback.js"), "utf8"), readFile(path.join(root, "adaptive-source-tracker.js"), "utf8")]);
  for (const id of ["fileInput", "sourceVideo", "displayCanvas", "analysisCanvas", "sourceCropCanvas", "scrubber", "trackButton", "resetButton", "exportButton", "shareButton", "statusText"]) { if (!html.includes(`id=\"${id}\"`)) errors.push(`index.html is missing #${id}.`); if (!app.includes(`#${id}`)) errors.push(`app.js does not bind #${id}.`); }
  for (const type of ["init", "frame", "reset", "point", "error"]) if (!worker.includes(`\"${type}\"`)) errors.push(`tracker.worker.js is missing the ${type} protocol message.`);
  for (const api of ["Tracker", "samplePatch", "classifyColour", "colourSimilarity"]) if (!core.includes(api)) errors.push(`tracker-core.js is missing ${api}.`);
  for (const api of ["buildPredictedTrajectory", "estimateMotion", "reliablePoints"]) if (!trajectory.includes(api)) errors.push(`trajectory.js is missing ${api}.`);
  for (const phrase of ["class GuardedTracker", "corridorWidth", "consistentDetectedPoints"]) if (!guard.includes(phrase)) errors.push(`tracking-guard.js is missing ${phrase}.`);
  for (const phrase of ["requestVideoFrameCallback", "__ballTraceFrameDuration", "1400"]) if (!frameFallback.includes(phrase)) errors.push(`safari-frame-fallback.js is missing ${phrase}.`);
  for (const api of ["AdaptiveSourceTracker", "FrameRateEstimator", "estimateInitialRadius", "findAdaptiveCandidate"]) if (!adaptive.includes(api)) errors.push(`adaptive-source-tracker.js is missing ${api}.`);
  for (const asset of ["/trajectory.js", "/tracking-guard.js", "/safari-frame-fallback.js", "/adaptive-source-tracker.js"]) if (!html.includes(asset)) errors.push(`index.html does not load ${asset}.`);
  if (!app.includes("BallTraceTrajectory.buildPredictedTrajectory")) errors.push("app.js does not create a predicted flight continuation.");
  if (!app.includes("new globalThis.BallTraceAdaptive.AdaptiveSourceTracker")) errors.push("app.js does not activate native-resolution adaptive tracking.");
  if (!app.includes("new Worker(\"/tracker.worker.js\")")) errors.push("app.js does not create the tracker worker.");
  if (!app.includes("captureStream")) errors.push("app.js does not implement local canvas export.");
  if (!app.includes("navigator.share")) errors.push("app.js does not implement Web Share export.");
}
if (mode === "--lint") {
  for (const file of files.filter((item) => /\.(?:js|mjs|json|html|css|md|yml|webmanifest)$/.test(item))) {
    const content = await readFile(file, "utf8"); const relative = path.relative(root, file);
    content.split("\n").forEach((line, index) => { if (/\s+$/.test(line)) errors.push(`${relative}:${index + 1} has trailing whitespace.`); if (line.includes("\t")) errors.push(`${relative}:${index + 1} contains a tab.`); });
    if (/\beval\s*\(|new Function\s*\(/.test(content)) errors.push(`${relative} uses dynamic code execution.`);
    if (relative.endsWith(".json") || relative.endsWith(".webmanifest")) try { JSON.parse(content); } catch (error) { errors.push(`${relative} is invalid JSON: ${error.message}`); }
  }
}
if (errors.length) { errors.forEach((error) => console.error(`- ${error}`)); process.exit(1); }
console.log(`${mode.slice(2)} checks passed (${scripts.length} scripts checked).`);
