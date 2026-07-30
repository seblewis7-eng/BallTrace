import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");
const assets = ["index.html", "styles.css", "app.js", "tracker-core.js", "trajectory.js", "tracking-guard.js", "safari-frame-fallback.js", "adaptive-source-tracker.js", "tracker.worker.js", "manifest.webmanifest", "sw.js", "favicon.svg", "icon.svg"];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) { const source = path.join(root, asset); await stat(source); await cp(source, path.join(output, asset)); }
const html = await readFile(path.join(output, "index.html"), "utf8");
for (const asset of ["styles.css", "app.js", "tracker-core.js", "trajectory.js", "tracking-guard.js", "safari-frame-fallback.js", "adaptive-source-tracker.js", "manifest.webmanifest", "icon.svg"]) if (!html.includes(`/${asset}`)) throw new Error(`index.html does not reference /${asset}`);
const manifest = JSON.parse(await readFile(path.join(output, "manifest.webmanifest"), "utf8"));
if (manifest.display !== "standalone") throw new Error("PWA manifest must use standalone display mode.");
if (!manifest.icons?.some((icon) => icon.sizes === "any")) throw new Error("PWA manifest needs a scalable icon.");
const serviceWorker = await readFile(path.join(output, "sw.js"), "utf8");
for (const asset of assets) if (!serviceWorker.includes(`/${asset}`) && asset !== "sw.js") throw new Error(`Service worker does not cache /${asset}`);
console.log(`Build complete: ${assets.length} assets written to dist/.`);
