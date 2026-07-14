import { createResilientWebcam } from '../src/index.js';

const video = document.querySelector('#camera');
const statusText = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const emptyState = document.querySelector('#empty-state');
const liveBadge = document.querySelector('#live-badge');
const log = document.querySelector('#event-log');
const startButton = document.querySelector('#start');
const restartButton = document.querySelector('#restart');
const stopButton = document.querySelector('#stop');
const captureButton = document.querySelector('#capture');
const clearLogButton = document.querySelector('#clear-log');
const detectBlack = document.querySelector('#detect-black');
const retryBlack = document.querySelector('#retry-black');
const capturedPanel = document.querySelector('#captured-panel');
const capturedImage = document.querySelector('#captured-image');
const captureMeta = document.querySelector('#capture-meta');

let captureUrl = null;
const camera = createResilientWebcam();
camera.attach(video);

function describeEvent(event) {
	if (event.type === 'error') {
		return `${event.error?.code ?? 'ERROR'}: ${event.error?.message ?? 'Camera error'}`;
	}
	if (event.type === 'status') {
		return `${event.previousState ?? 'unknown'} → ${event.state ?? camera.status.state}`;
	}
	if (event.type === 'recovery') {
		const attempt = event.attempt ? ` · attempt ${event.attempt}` : '';
		return `${event.phase ?? 'signal'} · ${event.reason ?? 'unknown'}${attempt}`;
	}
	if (event.type === 'stream') {
		return `${event.action ?? 'changed'}${event.reason ? ` · ${event.reason}` : ''}`;
	}
	if (event.type === 'capture') {
		return `${event.phase ?? 'completed'}${event.nearBlack ? ' · near black' : ''}`;
	}
	return event.type ?? 'event';
}

function appendLog(event) {
	const item = document.createElement('li');
	const time = document.createElement('time');
	const message = document.createElement('span');
	time.dateTime = new Date(event.timestamp ?? Date.now()).toISOString();
	time.textContent = new Date(event.timestamp ?? Date.now()).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	message.textContent = describeEvent(event);
	item.append(time, message);
	log.prepend(item);
	while (log.children.length > 80) {
		log.lastElementChild.remove();
	}
}

function renderState() {
	const state = camera.status.state;
	const isReady = state === 'ready';
	const isBusy = state === 'starting' || state === 'recovering';
	statusText.textContent = state;
	statusDot.className = `status-dot ${state}`;
	emptyState.hidden = isReady || isBusy;
	liveBadge.style.display = isReady ? 'block' : 'none';
	startButton.disabled = isReady || isBusy;
	restartButton.disabled = !isReady && state !== 'failed';
	stopButton.disabled = !isReady && !isBusy;
	captureButton.disabled = !isReady;
}

camera.subscribe((event) => {
	appendLog(event);
	renderState();
});

async function run(action) {
	try {
		await action();
	} catch (error) {
		appendLog({
			type: 'error',
			timestamp: Date.now(),
			error,
		});
	} finally {
		renderState();
	}
}

startButton.addEventListener('click', () => run(() => camera.start()));
restartButton.addEventListener('click', () => run(() => camera.restart()));
stopButton.addEventListener('click', () => run(() => camera.stop()));
clearLogButton.addEventListener('click', () => log.replaceChildren());

detectBlack.addEventListener('change', () => {
	retryBlack.disabled = !detectBlack.checked;
	if (!detectBlack.checked) {
		retryBlack.checked = false;
	}
});
retryBlack.disabled = true;

captureButton.addEventListener('click', () => run(async () => {
	const result = await camera.capture({
		blackFrameDetection: detectBlack.checked,
		restartAndRetryOnBlack: retryBlack.checked,
	});
	const blob = result instanceof Blob ? result : result.blob;
	if (!(blob instanceof Blob)) {
		throw new Error('capture() did not return a Blob');
	}
	if (captureUrl) {
		URL.revokeObjectURL(captureUrl);
	}
	captureUrl = URL.createObjectURL(blob);
	capturedImage.src = captureUrl;
	capturedPanel.hidden = false;
	const width = result.width ?? video.videoWidth;
	const height = result.height ?? video.videoHeight;
	const black = result.nearBlack ? ' · flagged near black' : '';
	const retried = result.retried ? ' · recaptured after restart' : '';
	captureMeta.textContent = `${width} × ${height} · ${blob.type || 'image'}${black}${retried}`;
}));

window.addEventListener('beforeunload', () => {
	camera.destroy();
	if (captureUrl) {
		URL.revokeObjectURL(captureUrl);
	}
});

renderState();
appendLog({ type: 'status', timestamp: Date.now(), previousState: '—', state: 'idle' });
