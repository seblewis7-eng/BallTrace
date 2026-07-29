# BallTrace

BallTrace is a personal, installable iPhone web-app prototype that tracks a selected golf ball through a short video and draws a red tracer from the positions the browser actually detects or briefly predicts.

## What is implemented

- Local iPhone video selection using a blob URL; the video is never uploaded.
- Frame-accurate timeline scrubbing and one-tap ball selection.
- White or yellow ball appearance sampling from the selected image patch.
- Worker-based hybrid tracking using motion, predicted position, velocity/direction continuity, colour, brightness, local contrast and patch similarity.
- `DETECTED`, short-gap `PREDICTED`, and terminal `LOST` tracking states.
- Adaptive 60 fps launch-window analysis, then 30 fps analysis, at a maximum 720 px long edge.
- Smoothed red tracer preview that grows with video playback.
- Debug overlay for selected, detected, predicted and smoothed positions, confidence, state and search region.
- Development-only tap correction after a lost track.
- 720p-class local canvas export through `MediaRecorder`, with MP4 preferred and WebM fallback.
- File sharing through the Web Share API when supported; download fallback otherwise.
- Final traced-frame PNG fallback if the browser cannot record a canvas stream.
- PWA manifest, service worker, standalone display, Apple touch icon, safe-area support and portrait/landscape layouts.

The tracker is custom Canvas/Worker computer vision rather than OpenCV.js so the first prototype remains small and has no large WASM download.

## Local run

```bash
npm install
npm run dev
```

Open the displayed local URL in a browser. For testing from an iPhone on the same network, expose the dev server over HTTPS or deploy the repository to Vercel.

## Checks

```bash
npm run test:tracker
npm run typecheck
npm run lint
npm run build
```

## Vercel deployment

1. Create a new GitHub repository named `BallTrace`.
2. Upload or push this repository to its `main` branch.
3. In Vercel, choose **Add New → Project**, import `BallTrace`, and keep the detected **Next.js** framework settings.
4. No environment variables, database, API keys or paid services are required.
5. Deploy, then open the generated HTTPS URL in iPhone Safari.

## Install on iPhone

1. Open the deployed HTTPS URL in Safari.
2. Tap Safari’s **Share** button.
3. Choose **Add to Home Screen**.
4. Confirm **BallTrace** and open it from the Home Screen.

## Known prototype limitations

- Best results require a short daylight shot, a stationary or nearly stationary camera, and a visible ball immediately before impact.
- Fast launch blur, compression, sky glare, camera movement, trees and similarly coloured objects can cause false matches.
- The ball can be briefly predicted for only three analysed frames. BallTrace intentionally stops rather than inventing the rest of the flight or landing point.
- Browser seeking does not guarantee access to every encoded 60 fps source frame; the launch window requests 60 timestamp samples and later drops to 30.
- Export runs in real time because the browser records a live canvas stream.
- Audio is included only when the browser exposes an audio track through media-element capture. iPhone Safari may produce a silent export.
- If canvas video recording is unavailable or fails, the app shares/downloads a final traced PNG rather than pretending a video was created.
- Large or long videos can exceed mobile memory. The intended input remains one 3–15 second shot.

## First tracker settings to tune

Settings live in `src/lib/tracker-types.ts` as `DEFAULT_TRACKER_SETTINGS`.

1. `detectedThreshold` and `reacquireThreshold`: lower slightly for missed balls; raise for false positives.
2. `preLaunchSearchRadius`: raise when the first post-impact displacement escapes the initial region; lower for noisy backgrounds.
3. `launchedSearchRadiusMax`: raise for very close, fast driver shots.
4. `maxPredictedGapFrames`: keep short; increasing it makes the tracer more speculative.
5. `launchSpeedPxPerSecond` and `launchDistancePx`: adjust if launch is triggered by golfer or club movement.
6. `smoothingAlpha`: raise for responsiveness, lower for a smoother but more delayed trace.
