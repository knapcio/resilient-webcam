export class FakeEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type, properties = {}) {
		const event = typeof type === 'string'
			? { type, target: this, ...properties }
			: type;
		for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
			listener.call(this, event);
		}
	}
}

export class FakeTrack extends FakeEventTarget {
	constructor({ deviceId = 'camera-1' } = {}) {
		super();
		this.kind = 'video';
		this.readyState = 'live';
		this.muted = false;
		this.deviceId = deviceId;
		this.stopCalls = 0;
	}

	getSettings() {
		return { deviceId: this.deviceId };
	}

	stop() {
		this.stopCalls += 1;
		this.readyState = 'ended';
	}

	end() {
		this.readyState = 'ended';
		this.dispatch('ended');
	}

	mute() {
		this.muted = true;
		this.dispatch('mute');
	}

	unmute() {
		this.muted = false;
		this.dispatch('unmute');
	}
}

export class FakeStream {
	constructor(tracks = [new FakeTrack()]) {
		this.tracks = tracks;
	}

	getTracks() {
		return this.tracks;
	}

	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === 'video');
	}
}

export class FakeMediaDevices extends FakeEventTarget {
	constructor(results = []) {
		super();
		this.results = [...results];
		this.calls = 0;
		this.constraints = [];
	}

	enqueue(result) {
		this.results.push(result);
	}

	getUserMedia(constraints) {
		this.calls += 1;
		this.constraints.push(constraints);
		if (this.results.length === 0) {
			throw new Error(`No fake getUserMedia result for call ${this.calls}`);
		}
		const result = this.results.shift();
		if (typeof result === 'function') {
			return result(constraints);
		}
		if (result instanceof Error) {
			return Promise.reject(result);
		}
		return Promise.resolve(result);
	}
}

export class FakeVideo extends FakeEventTarget {
	constructor({ frameCallbacks = true, width = 640, height = 480 } = {}) {
		super();
		this.srcObject = null;
		this.currentTime = 0;
		this.videoWidth = width;
		this.videoHeight = height;
		this.playCalls = 0;
		this.attributes = new Map();
		this.pendingFrameCallbacks = new Map();
		this.nextFrameCallbackId = 1;
		if (!frameCallbacks) {
			this.requestVideoFrameCallback = undefined;
			this.cancelVideoFrameCallback = undefined;
		}
	}

	setAttribute(name, value) {
		this.attributes.set(name, value);
	}

	play() {
		this.playCalls += 1;
		return Promise.resolve();
	}

	requestVideoFrameCallback(callback) {
		const id = this.nextFrameCallbackId;
		this.nextFrameCallbackId += 1;
		this.pendingFrameCallbacks.set(id, callback);
		return id;
	}

	cancelVideoFrameCallback(id) {
		this.pendingFrameCallbacks.delete(id);
	}

	firstFrameCallback() {
		return this.pendingFrameCallbacks.values().next().value;
	}

	presentFrame() {
		const entries = [...this.pendingFrameCallbacks.entries()];
		this.pendingFrameCallbacks.clear();
		for (const [, callback] of entries) {
			callback(Date.now(), { mediaTime: this.currentTime });
		}
	}
}

export class FakeDocument extends FakeEventTarget {
	constructor() {
		super();
		this.hidden = false;
	}

	setHidden(hidden) {
		this.hidden = hidden;
		this.dispatch('visibilitychange');
	}
}

export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

export function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitFor(predicate, { timeoutMs = 500, intervalMs = 2 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await delay(intervalMs);
	}
	throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

export function namedError(name, message = name) {
	const error = new Error(message);
	error.name = name;
	return error;
}

export function pixelData(value, width = 2, height = 2) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < data.length; index += 4) {
		data[index] = value;
		data[index + 1] = value;
		data[index + 2] = value;
		data[index + 3] = 255;
	}
	return data;
}

export function canvasFactory(frames, counters = {}) {
	const remainingFrames = [...frames];
	counters.created ??= 0;
	counters.drawImage ??= 0;
	counters.getImageData ??= 0;
	counters.toBlob ??= 0;
	return (width, height) => {
		counters.created += 1;
		const frame = remainingFrames.shift() ?? pixelData(255, width, height);
		const context = {
			drawImage() {
				counters.drawImage += 1;
			},
			getImageData() {
				counters.getImageData += 1;
				return { data: frame };
			},
		};
		return {
			width,
			height,
			getContext() {
				return context;
			},
			toBlob(callback, type) {
				counters.toBlob += 1;
				callback(new Blob(['capture'], { type }));
			},
		};
	};
}
