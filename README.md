# resilient-webcam

**A zero-dependency webcam controller for browser and Electron applications that
need to keep running without a person refreshing the page.**

`resilient-webcam` owns one `getUserMedia()` stream, watches the signals that
ordinary webcam components ignore, and performs bounded, observable recovery.
It is framework-neutral ESM: no native add-on, helper executable, service,
upload, storage, or telemetry.

## Why this exists

Most webcam wrappers make the happy path convenient: request a stream, put it
in a `<video>`, and take a screenshot. That is enough for a user-operated
page. It is not enough for a kiosk that can run for weeks.

Real USB cameras and drivers can stop producing frames while the page remains
responsive. Tracks can mute, end, or disappear after a USB or power event.
Opening a preview or rebooting appears to “fix” the problem because it creates
a new stream. This library makes that lifecycle explicit and recoverable.

| Ordinary wrapper | `resilient-webcam` |
| --- | --- |
| Starts a camera | Owns exactly one stream and cleans up stale requests |
| Reports permission errors | Normalizes errors and emits lifecycle events |
| May expose a manual restart | Coalesces automatic restarts into one recovery flight |
| Assumes a live track means live video | Watches ended, mute, device-change, and fresh-frame signals |
| Retries indefinitely or not at all | Uses bounded exponential backoff with jitter |
| Takes a screenshot | Can conservatively flag a near-black frame and recapture once |

## Installation

```sh
npm install resilient-webcam
```

The package ships modern browser ESM and TypeScript declarations. It has no
runtime dependencies.

For local repository development:

```sh
git clone https://github.com/knapcio/resilient-webcam.git
cd resilient-webcam
npm install
npm run check
```

## Demo

Run the dependency-free local server:

```sh
npm run demo
```

Then open [http://localhost:4173/demo/](http://localhost:4173/demo/). The demo
shows the local preview, state transitions, recovery events, and an optional
near-black capture check. Images are displayed with an in-memory object URL and
are never sent anywhere.

The `demo/` directory is also fully static and can be hosted on GitHub Pages.
After Pages is enabled for this repository, its expected URL is
`https://knapcio.github.io/resilient-webcam/demo/`. Camera access requires
HTTPS when the page is not on localhost.

## Quick start

```html
<video id="camera"></video>
<button id="start">Start camera</button>
<button id="capture">Capture</button>
```

```js
import { createResilientWebcam } from 'resilient-webcam';

const video = document.querySelector('#camera');
const camera = createResilientWebcam({
  videoConstraints: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
  },
});

camera.attach(video);

const unsubscribe = camera.subscribe((event) => {
  // Select only the metadata your application actually needs.
  console.log({
    type: event.type,
    state: event.status.state,
    reason: event.reason,
    phase: event.phase,
    errorCode: event.error?.code,
  });
});

document.querySelector('#start').addEventListener('click', async () => {
  await camera.start();
});

document.querySelector('#capture').addEventListener('click', async () => {
  const result = await camera.capture({ type: 'image/jpeg', quality: 0.9 });
  const imageUrl = URL.createObjectURL(result.blob);
  // Use the Blob, then revoke the URL when it is no longer displayed.
  URL.revokeObjectURL(imageUrl);
});

// When this screen is permanently removed:
unsubscribe();
camera.destroy();
```

Call `start()` from a user gesture when possible. Browsers control camera
permission and may reject requests that are not initiated by a user.

## API

### `createResilientWebcam(options?)`

Creates an isolated controller. Constructing it does not request camera
permission.

Common options:

| Option | Default | Purpose |
| --- | --- | --- |
| `videoConstraints` | `true` | The video portion of the `getUserMedia` constraints. Audio is always disabled. |
| `requestTimeoutMs` | `12000` | Stops waiting for a camera request; a late stream is immediately closed. |
| `playTimeoutMs` | `5000` | Bounds video-element playback so a stuck `play()` cannot freeze recovery. |
| `muteGraceMs` | `5000` | How long a track may stay muted before recovery. `unmute` cancels the timer. |
| `frameTimeoutMs` | `12000` | Maximum time without a presented frame. Set to `0` to disable the frame watchdog. |
| `pauseWhenHidden` | `true` | Pauses frame monitoring and defers automatic recovery while the document is intentionally hidden. |
| `restartOnDeviceChange` | `true` | Restarts after a debounced `devicechange` signal. |
| `deviceChangeDebounceMs` | `500` | Coalesces a burst of operating-system device changes. |
| `maxRecoveryAttempts` | `5` | Maximum attempts in one unhealthy period. |
| `recoveryInitialDelayMs` | `500` | Delay before the first automatic recovery attempt. |
| `recoveryMaxDelayMs` | `10000` | Backoff ceiling. |
| `recoveryBackoffFactor` | `2` | Exponential backoff multiplier. |
| `recoveryJitter` | `0.2` | Random variation from `0` to `1`, reducing synchronized retries. |
| `recoveryResetAfterMs` | `30000` | Healthy time before the attempt budget resets. |
| `capture` | see below | Default capture settings. |

Advanced tests or controlled environments can inject `mediaDevices`,
`document`, `now`, `random`, or `canvasFactory`. Applications normally
should not set them.

### Lifecycle methods

#### `attach(videoElement)`

Attaches the owned stream to an `HTMLVideoElement` and configures it for muted,
inline autoplay. A controller can have one attached video element.

#### `detach()`

Removes the current video target and pauses frame monitoring. It does not stop
the stream, which makes moving a preview between UI containers inexpensive.

#### `await start()`

Requests a video-only `MediaStream`, attaches it if a video element is present,
and resolves with the stream when ready. Concurrent calls share one request.
Permission, device, and constraint failures reject with
`ResilientWebcamError`.

#### `stop()`

Marks the camera intentionally stopped, cancels pending recovery, removes
listeners and timers, and stops every owned track. A late
`getUserMedia()` result is recognized as stale and stopped too.

#### `await restart(reason?)`

Performs an explicit restart. Restart calls are single-flight: overlapping
signals share the same work rather than opening several streams.

#### `destroy()`

Permanently stops the controller, detaches the video element, and removes
subscribers. A destroyed instance cannot be started again.

### State and events

`camera.status` is a snapshot containing the current `state`, attachment and
stream flags, recovery attempt, last recovery reason, last fresh-frame time,
and last error. `camera.stream` returns the current `MediaStream` or `null`.

States are:

- `idle` — created but never started
- `starting` — waiting for the initial media request
- `ready` — owns a live stream
- `recovering` — a bounded restart is scheduled or running
- `stopped` — intentionally stopped
- `failed` — initial start failed or recovery was exhausted
- `destroyed` — permanently cleaned up

`subscribe(listener)` receives all events and returns an unsubscribe function.
Events have a numeric `timestamp`, a `type`, and type-specific fields:

- `status`: previous state, next state, and transition reason
- `stream`: stream started or stopped (metadata only; no frame contents)
- `recovery`: deferred, scheduled, attempting, succeeded, failed, exhausted,
  coalesced, or reset
- `error`: a normalized `ResilientWebcamError`
- `capture`: capture metadata such as dimensions and near-black result

Errors expose `code`, `recoverable`, optional `details`, and the original
`cause` when the platform supplied one. Event callbacks are observational:
throwing from a callback does not interrupt camera cleanup or recovery.

### Capture

```js
const result = await camera.capture({
  type: 'image/webp',
  quality: 0.88,
  width: 960, // height is inferred when omitted
  blackFrameDetection: {
    luminanceThreshold: 16,
    darkPixelRatio: 0.985,
    sampleStride: 8,
  },
  restartAndRetryOnBlack: true,
});
```

`capture()` draws the current frame to a short-lived canvas and resolves to:

```js
{
  blob,          // caller-owned Blob
  width,
  height,
  type,
  nearBlack,
  analysis,      // null unless detection was enabled
  retried,       // true only for the single post-restart capture
  capturedAt
}
```

Capture defaults can be placed under the constructor's `capture` option.
`readyTimeoutMs` and `encodeTimeoutMs` both default to `5000`, bounding the
wait for usable video dimensions and canvas encoding respectively.
Near-black detection is **off by default**. When enabled, it samples luminance;
when `restartAndRetryOnBlack` is also true, at most one restart and one fresh
capture occur. The controller retains neither capture.

## Recovery semantics

The controller listens for several independent signs of an unhealthy camera:

1. A video track emits `ended`: recovery begins immediately.
2. A track remains muted beyond `muteGraceMs`: recovery begins; `unmute`
   inside the grace period cancels it.
3. `mediaDevices` emits `devicechange`: events are debounced before recovery.
4. An attached, visible video produces no fresh frames for `frameTimeoutMs`:
   recovery begins. `requestVideoFrameCallback()` is preferred, with
   `timeupdate` and media-time polling as a fallback.

Signals are ignored after `stop()`. With `pauseWhenHidden`, frame monitoring
pauses and recovery signals are deferred until the document becomes visible.
Every recovery closes the old stream before requesting a replacement. Failed
attempts use exponential backoff plus jitter and stop at the configured bound.
After a stable interval, the attempt budget resets.

Recovery can repair a stale browser stream. It cannot reset a USB controller,
repair a Windows/macOS/Linux driver, fix insufficient power, or revive failed
camera hardware. Applications should log recovery reason and error metadata so
repeated failures can be correlated with device maintenance.

## React integration

No React adapter is required. Keep the controller in a ref and let React own
only the element:

```jsx
import { useEffect, useRef, useState } from 'react';
import { createResilientWebcam } from 'resilient-webcam';

export function CameraPanel() {
  const videoRef = useRef(null);
  const cameraRef = useRef(null);
  const [state, setState] = useState('idle');

  useEffect(() => {
    const camera = createResilientWebcam();
    cameraRef.current = camera;
    camera.attach(videoRef.current);
    const unsubscribe = camera.subscribe((event) => {
      if (event.type === 'status') setState(event.state);
    });
    return () => {
      unsubscribe();
      camera.destroy();
      cameraRef.current = null;
    };
  }, []);

  return (
    <section>
      <video ref={videoRef} />
      <p>{state}</p>
      <button onClick={() => cameraRef.current?.start()}>Start</button>
      <button onClick={() => cameraRef.current?.restart()}>Restart</button>
      <button onClick={() => cameraRef.current?.stop()}>Stop</button>
    </section>
  );
}
```

This survives normal React rerenders without transferring stream ownership.
Development Strict Mode cleanup is also safe because `destroy()` is idempotent.

### Adapting a capture to an existing data-URL API

`capture()` deliberately returns a `Blob`, which avoids a second in-memory
base64 copy. If an existing POS or kiosk pipeline expects a JPEG data URL, keep
that conversion at the application boundary:

```js
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function takePhotoWithoutBlockingCheckout(camera) {
  try {
    const { blob } = await camera.capture({
      type: 'image/jpeg',
      quality: 0.92,
      blackFrameDetection: true,
      restartAndRetryOnBlack: true,
    });
    return await blobToDataUrl(blob);
  } catch (error) {
    console.warn('Camera capture unavailable; continuing without an image', error);
    return null;
  }
}
```

The black-frame options are especially useful for unattended checkout cameras:
a driver can continue presenting fresh but entirely black frames, so a frame
stall watchdog alone cannot recognize that failure. A dark room can also be a
legitimate near-black image; tune the thresholds for the deployment.

## Electron integration

Use the library in the renderer exactly as in a browser:

```js
// renderer.js
import { createResilientWebcam } from 'resilient-webcam';

const camera = createResilientWebcam({
  videoConstraints: { width: { ideal: 1920 }, height: { ideal: 1080 } },
});
camera.attach(document.querySelector('video'));
await camera.start();
```

Electron still delegates media access to Chromium and the operating-system
driver. Configure a narrow permission handler in the main process for your
trusted renderer origin; never grant every permission to every origin:

```js
// main.js — run after app.whenReady() and adapt this exact path.
const mainWindow = createMainWindow();
const trustedWebContents = mainWindow.webContents;
const trustedRendererUrl = 'file:///absolute/path/to/your/app/';

session.defaultSession.setPermissionRequestHandler((
  webContents,
  permission,
  callback,
  details,
) => {
  const isTrustedWindow = webContents === trustedWebContents;
  const isTrustedUrl = details.requestingUrl.startsWith(trustedRendererUrl);
  const asksForAudio = details.mediaTypes?.includes('audio') ?? false;
  callback(
    permission === 'media'
    && isTrustedWindow
    && isTrustedUrl
    && !asksForAudio
  );
});
```

Import `session` from Electron in the main process. The handler denies media
requests from every other window or renderer URL; keep the trusted path as
narrow as your packaging layout allows.

Keep `contextIsolation` enabled and `nodeIntegration` disabled for remote
content. The library does not require Node APIs, native modules, or a companion
process.

## Privacy and security

- Only video is requested; audio is always disabled.
- No frame, label, event, or error is uploaded by this package.
- No telemetry or persistent storage is included.
- Capture blobs belong to the caller and are not retained internally.
- Camera permission and user consent remain the application's responsibility.
- Lifecycle events contain no pixels, but their status snapshot can contain an
  opaque camera device ID and errors can contain platform details. Select fields
  for logs instead of forwarding whole event objects.
- Avoid logging device labels or capture contents unless they are genuinely
  needed and handled under your privacy policy.

## Limitations

- Near-black detection can flag a legitimate image in a dark room. Tune it
  against your environment and treat the result as a signal, not proof.
- A frozen image may still be presented as new frames by some drivers. Browser
  frame callbacks cannot detect identical content without expensive pixel
  comparison, which v0.1 intentionally does not perform.
- Background throttling varies by browser; hidden-document recovery is deferred
  by default to prevent false restart loops.
- Chromium can suppress frame callbacks for an offscreen or occluded preview.
  Advancing media time is also treated as healthy, but deployments that cannot
  present a reliable offscreen signal should set `frameTimeoutMs: 0` and rely on
  track, device-change, and capture health signals.
- Browsers may retain camera permission and device selection differently.
- There is no recording, uploading, QR scanning, UI component, or framework
  abstraction. Those features are intentionally outside the core.

## Browser support

A secure context with `navigator.mediaDevices.getUserMedia`,
`HTMLVideoElement.srcObject`, canvas `toBlob`, and ES modules is required.
Current Chromium, Firefox, Safari, and Chromium-based Electron releases provide
these primitives. Exact camera and background behavior depends on the browser,
operating system, and driver, so validate on the hardware you deploy.

## Development

```sh
npm test             # node:test lifecycle tests with fake media devices
npm run lint         # syntax, whitespace, and zero-runtime-dependency checks
npm run pack:check   # inspect the npm tarball without publishing
npm run check        # all of the above
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), and
[RELEASING.md](./RELEASING.md) for project policies.

## License

MIT © 2026 Zbigniew Majewski
