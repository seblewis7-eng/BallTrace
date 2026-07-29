# BallTrace

BallTrace is an installable iPhone web app that analyses a short imported golf video in the browser, follows a selected white or yellow golf ball through subsequent frames, and draws a tracer from detected positions.

The prototype is dependency-free. It runs as a static progressive web app on Vercel, uses no backend, database, paid API, account, Mac, Xcode, or Apple Developer membership, and never uploads the selected video.

## Workflow

1. Select a 3–15 second golf video.
2. Scrub to immediately before impact.
3. Tap the ball once.
4. Press **Track ball**.
5. Preview the tracer and export or share the result.

The user does not choose an apex, landing point, curve, or extra flight points.

## How tracking works

`tracker.worker.js` runs frame analysis away from the interface. `tracker-core.js` evaluates candidates using the selected ball appearance, white/yellow colour classification, frame-to-frame motion, predicted position, velocity continuity, brightness, contrast, and an adaptive search radius. Frames are sampled at 60 timestamps per second during launch and 30 afterwards. Missing detections are predicted for only a few frames before tracking reports `LOST`.

## Local checks

Node.js 22 or newer is required.

```bash
npm ci
npm run test:tracker
npm run typecheck
npm run lint
npm run build
```

The build creates a deployable `dist/` directory.

## Deploy

Import the repository into Vercel. `vercel.json` runs `npm ci` and `npm run build`, then serves `dist/`. No environment variables are required. Open the HTTPS deployment in iPhone Safari and use **Share → Add to Home Screen**.

## Export

BallTrace prefers a local MP4 canvas recording, falls back to WebM, and creates a traced PNG when canvas recording is unavailable. Sharing uses the Web Share API with a download fallback.

## Prototype limitations

Best results need a short daylight clip, a visible ball at the selected frame, and a stationary or nearly stationary camera. Heavy compression, motion blur, glare, foliage, camera movement, and similarly coloured objects can reduce confidence. Export runs in real time and is silent because iPhone media-element audio capture is inconsistent.
