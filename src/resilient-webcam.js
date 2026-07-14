import {
	ErrorCodes,
	ResilientWebcamError,
	normalizeMediaError,
	operationCancelledError,
} from './errors.js';
import { analyzeFramePixels, resolveCaptureSize } from './frame.js';

export const WebcamStates = Object.freeze({
	IDLE: 'idle',
	STARTING: 'starting',
	READY: 'ready',
	RECOVERING: 'recovering',
	STOPPED: 'stopped',
	FAILED: 'failed',
	DESTROYED: 'destroyed',
});

export const RecoveryReasons = Object.freeze({
	MANUAL: 'manual',
	TRACK_ENDED: 'track-ended',
	TRACK_MUTED: 'track-muted',
	DEVICE_CHANGE: 'device-change',
	FRAME_STALLED: 'frame-stalled',
	BLACK_FRAME: 'black-frame',
	VIDEO_PLAY_FAILED: 'video-play-failed',
});

const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
	type: 'image/jpeg',
	quality: 0.92,
	readyTimeoutMs: 5000,
	encodeTimeoutMs: 5000,
	blackFrameDetection: false,
	restartAndRetryOnBlack: false,
});

const DEFAULT_OPTIONS = Object.freeze({
	videoConstraints: true,
	requestTimeoutMs: 12000,
	playTimeoutMs: 5000,
	muteGraceMs: 5000,
	frameTimeoutMs: 12000,
	pauseWhenHidden: true,
	restartOnDeviceChange: true,
	deviceChangeDebounceMs: 500,
	maxRecoveryAttempts: 5,
	recoveryInitialDelayMs: 500,
	recoveryMaxDelayMs: 10000,
	recoveryBackoffFactor: 2,
	recoveryJitter: 0.2,
	recoveryResetAfterMs: 30000,
});

function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function stopStream(stream) {
	for (const track of stream?.getTracks?.() ?? []) {
		try {
			track.stop();
		} catch {
			// A platform track may already be gone. Cleanup must remain idempotent.
		}
	}
}

function getVideoTracks(stream) {
	if (typeof stream?.getVideoTracks === 'function') {
		return stream.getVideoTracks();
	}
	return (stream?.getTracks?.() ?? []).filter((track) => track?.kind === 'video');
}

function isLiveStream(stream) {
	return getVideoTracks(stream).some((track) => track?.readyState !== 'ended');
}

function assertNumber(name, value, { integer = false, min = 0, max = Infinity } = {}) {
	if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
		const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			`${name} must be ${integer ? 'an integer ' : ''}${range}`,
		);
	}
}

function validateOptions(options) {
	if (options.videoConstraints === false || (
		options.videoConstraints !== true
		&& (typeof options.videoConstraints !== 'object' || options.videoConstraints === null)
	)) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'videoConstraints must be true or a MediaTrackConstraints object',
		);
	}

	assertNumber('requestTimeoutMs', options.requestTimeoutMs, { min: 1 });
	assertNumber('playTimeoutMs', options.playTimeoutMs, { min: 1 });
	assertNumber('muteGraceMs', options.muteGraceMs);
	assertNumber('frameTimeoutMs', options.frameTimeoutMs);
	assertNumber('deviceChangeDebounceMs', options.deviceChangeDebounceMs);
	assertNumber('maxRecoveryAttempts', options.maxRecoveryAttempts, { integer: true, min: 1 });
	assertNumber('recoveryInitialDelayMs', options.recoveryInitialDelayMs);
	assertNumber('recoveryMaxDelayMs', options.recoveryMaxDelayMs);
	assertNumber('recoveryBackoffFactor', options.recoveryBackoffFactor, { min: 1 });
	assertNumber('recoveryJitter', options.recoveryJitter, { min: 0, max: 1 });
	assertNumber('recoveryResetAfterMs', options.recoveryResetAfterMs);

	for (const callback of ['onEvent', 'onStatus', 'onRecovery', 'onError']) {
		if (options[callback] !== undefined && typeof options[callback] !== 'function') {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				`${callback} must be a function`,
			);
		}
	}
	if (options.canvasFactory !== undefined && typeof options.canvasFactory !== 'function') {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'canvasFactory must be a function',
		);
	}
}

function validateCaptureOptions(options) {
	if (typeof options.type !== 'string' || !options.type.trim()) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'capture type must be a non-empty MIME type',
		);
	}
	assertNumber('capture quality', options.quality, { min: 0, max: 1 });
	assertNumber('capture readyTimeoutMs', options.readyTimeoutMs, { min: 1 });
	assertNumber('capture encodeTimeoutMs', options.encodeTimeoutMs, { min: 1 });
	if (
		options.blackFrameDetection !== false
		&& options.blackFrameDetection !== true
		&& (typeof options.blackFrameDetection !== 'object' || options.blackFrameDetection === null)
	) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'blackFrameDetection must be a boolean or an options object',
		);
	}
}

function addEventListener(target, type, listener) {
	if (typeof target?.addEventListener !== 'function') {
		return false;
	}
	target.addEventListener(type, listener);
	return true;
}

function removeEventListener(target, type, listener) {
	try {
		target?.removeEventListener?.(type, listener);
	} catch {
		// Some fakes and partially disconnected devices throw during cleanup.
	}
}

export class ResilientWebcam {
	constructor(options = {}) {
		if (typeof options !== 'object' || options === null || Array.isArray(options)) {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'Controller options must be an object',
			);
		}
		if (
			options.capture !== undefined
			&& (typeof options.capture !== 'object' || options.capture === null || Array.isArray(options.capture))
		) {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'capture defaults must be an object',
			);
		}
		const resolvedOptions = {
			...DEFAULT_OPTIONS,
			...options,
			capture: {
				...DEFAULT_CAPTURE_OPTIONS,
				...(options.capture ?? {}),
			},
		};
		validateOptions(resolvedOptions);
		validateCaptureOptions(resolvedOptions.capture);

		this._options = resolvedOptions;
		this._mediaDevices = hasOwn(options, 'mediaDevices')
			? options.mediaDevices
			: globalThis.navigator?.mediaDevices;
		this._document = hasOwn(options, 'document')
			? options.document
			: globalThis.document ?? null;
		this._now = options.now ?? Date.now;
		this._random = options.random ?? Math.random;
		this._canvasFactory = options.canvasFactory ?? null;
		if (typeof this._now !== 'function' || typeof this._random !== 'function') {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'now and random must be functions when provided',
			);
		}

		this._state = WebcamStates.IDLE;
		this._desiredRunning = false;
		this._destroyed = false;
		this._stream = null;
		this._video = null;
		this._subscribers = new Set();
		this._operationId = 0;
		this._pendingRequest = null;
		this._startPromise = null;
		this._restartPromise = null;
		this._recoveryTimer = null;
		this._recoveryAttempt = 0;
		this._lastRecoveryReason = null;
		this._lastError = null;
		this._recoveryResetTimer = null;
		this._deferredRecoveryReason = null;
		this._queuedRecoveryReason = null;
		this._deviceChangeTimer = null;
		this._globalListenersBound = false;
		this._trackListeners = [];
		this._muteTimers = new Map();
		this._frameMonitorToken = 0;
		this._frameCallbackId = null;
		this._frameCallbackVideo = null;
		this._framePollTimer = null;
		this._frameDeadlineTimer = null;
		this._frameObservedVideo = null;
		this._frameTimeListener = null;
		this._frameMonitorStartedAt = null;
		this._lastObservedMediaTime = null;
		this._lastFrameAt = null;
		this._captureWaiters = new Set();

		this._handleDeviceChange = this._handleDeviceChange.bind(this);
		this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
	}

	get state() {
		return this._state;
	}

	get stream() {
		return this._stream;
	}

	get video() {
		return this._video;
	}

	get status() {
		const videoTrack = getVideoTracks(this._stream)[0] ?? null;
		let deviceId = null;
		try {
			deviceId = videoTrack?.getSettings?.().deviceId ?? null;
		} catch {
			deviceId = null;
		}

		return Object.freeze({
			state: this._state,
			desiredRunning: this._desiredRunning,
			attached: this._video !== null,
			hasStream: this._stream !== null,
			deviceId,
			recoveryAttempt: this._recoveryAttempt,
			maxRecoveryAttempts: this._options.maxRecoveryAttempts,
			lastRecoveryReason: this._lastRecoveryReason,
			lastFrameAt: this._lastFrameAt,
			lastError: this._lastError,
		});
	}

	attach(video) {
		this._assertUsable();
		if (!video || typeof video !== 'object' || !('srcObject' in video)) {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'attach() requires an HTMLVideoElement-like object with srcObject',
			);
		}
		if (video === this._video) {
			return this;
		}

		this.detach();
		this._video = video;
		this._configureVideo(video);
		if (this._stream) {
			this._connectVideo(video, this._stream).catch((error) => {
				if (this._video !== video || this._stream === null || this._destroyed) {
					return;
				}
				this._emitError(error);
				if (this._desiredRunning) {
					this._triggerRecovery(RecoveryReasons.VIDEO_PLAY_FAILED);
				}
			});
		}
		return this;
	}

	detach() {
		this._stopFrameMonitor();
		const video = this._video;
		this._video = null;
		if (video && video.srcObject === this._stream) {
			try {
				video.srcObject = null;
			} catch {
				// The element may be in the middle of browser teardown.
			}
		}
		return this;
	}

	start() {
		try {
			this._assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		if (this._stream && isLiveStream(this._stream)) {
			this._desiredRunning = true;
			return Promise.resolve(this._stream);
		}
		if (this._startPromise) {
			return this._startPromise;
		}
		if (this._restartPromise) {
			return this._restartPromise.then((stream) => {
				if (!stream) {
					throw this._lastError ?? operationCancelledError();
				}
				return stream;
			});
		}

		this._desiredRunning = true;
		this._lastError = null;
		this._deferredRecoveryReason = null;
		this._queuedRecoveryReason = null;
		this._cancelRecoveryTimer();
		this._bindGlobalListeners();
		this._cancelPendingRequest();
		const operationId = ++this._operationId;
		let resolveStart;
		let rejectStart;
		const promise = new Promise((resolve, reject) => {
			resolveStart = resolve;
			rejectStart = reject;
		});
		this._startPromise = promise;
		this._setState(WebcamStates.STARTING, 'start');

		const work = (this._isOperationActive(operationId)
			? this._requestAndAdopt(operationId, 'start')
			: Promise.reject(operationCancelledError()))
			.then((stream) => {
				if (!this._isOperationActive(operationId)) {
					stopStream(stream);
					throw operationCancelledError();
				}
				if (!isLiveStream(stream)) {
					this._queuedRecoveryReason ??= RecoveryReasons.TRACK_ENDED;
				}
				this._recoveryAttempt = 0;
				this._setState(
					this._queuedRecoveryReason ? WebcamStates.RECOVERING : WebcamStates.READY,
					this._queuedRecoveryReason ? 'start-unhealthy' : 'start-succeeded',
				);
				if (!this._isOperationActive(operationId) || stream !== this._stream) {
					throw operationCancelledError();
				}
				return stream;
			})
			.catch((error) => {
				const normalized = normalizeMediaError(error);
				if (this._isOperationActive(operationId)) {
					this._desiredRunning = false;
					this._lastError = normalized;
					this._unbindGlobalListeners();
					this._setState(WebcamStates.FAILED, 'start-failed');
					this._emitError(normalized);
				}
				throw normalized;
			});
		work.then((stream) => {
			if (this._startPromise === promise) {
				this._startPromise = null;
				this._drainQueuedRecovery();
			}
			resolveStart(stream);
		}, (error) => {
			if (this._startPromise === promise) {
				this._startPromise = null;
				this._drainQueuedRecovery();
			}
			rejectStart(error);
		});
		return promise;
	}

	stop() {
		if (this._destroyed) {
			return;
		}
		this._stopInternal('stop');
		this._setState(WebcamStates.STOPPED, 'stop');
	}

	restart(reason = RecoveryReasons.MANUAL) {
		try {
			this._assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		if (this._restartPromise) {
			this._emit({
				type: 'recovery',
				phase: 'coalesced',
				reason: String(reason),
			});
			return this._waitForRecoveryOutcome();
		}

		const recoveryReason = String(reason || RecoveryReasons.MANUAL);
		this._desiredRunning = true;
		this._lastError = null;
		this._lastRecoveryReason = recoveryReason;
		this._recoveryAttempt = 0;
		this._deferredRecoveryReason = null;
		this._queuedRecoveryReason = null;
		this._cancelRecoveryTimer();
		this._cancelRecoveryReset();
		this._bindGlobalListeners();
		const promise = Promise.resolve()
			.then(() => {
				if (
					this._restartPromise !== promise
					|| !this._desiredRunning
					|| this._destroyed
				) {
					throw operationCancelledError();
				}
				return this._executeRestartRequest(recoveryReason);
			})
			.then((stream) => {
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				if (!isLiveStream(stream)) {
					this._queuedRecoveryReason ??= RecoveryReasons.TRACK_ENDED;
				}
				this._recoveryAttempt = 0;
				this._setState(
					this._queuedRecoveryReason ? WebcamStates.RECOVERING : WebcamStates.READY,
					this._queuedRecoveryReason
						? `${recoveryReason}-still-unhealthy`
						: `${recoveryReason}-succeeded`,
				);
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				this._emit({
					type: 'recovery',
					phase: 'succeeded',
					reason: recoveryReason,
					attempt: 1,
				});
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				return stream;
			})
			.catch((error) => {
				const normalized = normalizeMediaError(error);
				if (
					this._restartPromise === promise
					&& this._desiredRunning
					&& !this._destroyed
				) {
					this._desiredRunning = false;
					this._lastError = normalized;
					this._unbindGlobalListeners();
					this._setState(WebcamStates.FAILED, `${recoveryReason}-failed`);
					this._emitError(normalized);
					this._emit({
						type: 'recovery',
						phase: 'failed',
						reason: recoveryReason,
						attempt: 1,
						error: normalized,
					});
				}
				throw normalized;
			})
			.finally(() => {
				if (this._restartPromise === promise) {
					this._restartPromise = null;
					this._drainQueuedRecovery();
				}
			});
		this._restartPromise = promise;
		this._setState(WebcamStates.RECOVERING, recoveryReason);
		if (
			this._restartPromise === promise
			&& this._desiredRunning
			&& !this._destroyed
		) {
			this._emit({
				type: 'recovery',
				phase: 'attempting',
				reason: recoveryReason,
				attempt: 1,
				maxAttempts: 1,
			});
		}
		return promise;
	}

	async capture(options = {}) {
		this._assertUsable();
		if (typeof options !== 'object' || options === null || Array.isArray(options)) {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'capture options must be an object',
			);
		}
		const captureOptions = {
			...this._options.capture,
			...options,
		};
		validateCaptureOptions(captureOptions);

		try {
			return await this._captureOnce(captureOptions, false);
		} catch (error) {
			const normalized = error instanceof ResilientWebcamError
				? error
				: new ResilientWebcamError(
					ErrorCodes.CAPTURE_FAILED,
					'Unable to capture a camera frame',
					{ cause: error },
				);
			this._emitError(normalized);
			throw normalized;
		}
	}

	subscribe(listener) {
		this._assertUsable();
		if (typeof listener !== 'function') {
			throw new ResilientWebcamError(
				ErrorCodes.INVALID_ARGUMENT,
				'subscribe() requires a function',
			);
		}
		this._subscribers.add(listener);
		return () => {
			this._subscribers.delete(listener);
		};
	}

	destroy() {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this._stopInternal('destroy');
		this.detach();
		this._setState(WebcamStates.DESTROYED, 'destroy');
		this._subscribers.clear();
	}

	_assertUsable() {
		if (this._destroyed) {
			throw new ResilientWebcamError(
				ErrorCodes.DESTROYED,
				'This webcam controller has been destroyed',
				{ recoverable: false },
			);
		}
	}

	_isOperationActive(operationId) {
		return !this._destroyed
			&& this._desiredRunning
			&& this._operationId === operationId;
	}

	_isAdoptedStreamActive(stream) {
		return !this._destroyed
			&& this._desiredRunning
			&& stream === this._stream;
	}

	_setState(state, reason) {
		if (this._state === state) {
			return;
		}
		const previousState = this._state;
		this._state = state;
		this._emit({
			type: 'status',
			previousState,
			state,
			reason,
		});
	}

	_emit(event) {
		const enriched = Object.freeze({
			...event,
			timestamp: this._now(),
			status: this.status,
		});
		const callbacks = [this._options.onEvent];
		if (enriched.type === 'status') {
			callbacks.push(this._options.onStatus);
		} else if (enriched.type === 'recovery') {
			callbacks.push(this._options.onRecovery);
		} else if (enriched.type === 'error') {
			callbacks.push(this._options.onError);
		}
		for (const callback of new Set([...callbacks, ...this._subscribers])) {
			if (typeof callback !== 'function') {
				continue;
			}
			try {
				callback(enriched);
			} catch {
				// Observers must never be able to interrupt media cleanup or recovery.
			}
		}
		return enriched;
	}

	_emitError(error) {
		const normalized = normalizeMediaError(error);
		this._lastError = normalized;
		this._emit({ type: 'error', error: normalized });
		return normalized;
	}

	_configureVideo(video) {
		try {
			video.muted = true;
			video.autoplay = true;
			video.playsInline = true;
			video.setAttribute?.('muted', '');
			video.setAttribute?.('autoplay', '');
			video.setAttribute?.('playsinline', '');
		} catch {
			// Assignment can fail on a disconnected test double; srcObject is decisive.
		}
	}

	async _connectVideo(video, stream) {
		if (video !== this._video || stream !== this._stream) {
			return;
		}
		this._configureVideo(video);
		video.srcObject = stream;
		try {
			const playResult = video.play?.();
			if (playResult && typeof playResult.then === 'function') {
				await this._withTimeout(
					playResult,
					this._options.playTimeoutMs,
					() => new ResilientWebcamError(
						ErrorCodes.VIDEO_PLAY_FAILED,
						`The video element did not begin playback within ${this._options.playTimeoutMs}ms`,
					),
				);
			}
		} catch (error) {
			if (video !== this._video || stream !== this._stream) {
				return;
			}
			throw new ResilientWebcamError(
				ErrorCodes.VIDEO_PLAY_FAILED,
				'The camera stream was acquired but the video element could not play it',
				{ cause: error },
			);
		}
		if (video === this._video && stream === this._stream) {
			this._startFrameMonitor();
		}
	}

	_requestAndAdopt(operationId, reason) {
		if (!this._isOperationActive(operationId)) {
			return Promise.reject(operationCancelledError());
		}
		return this._requestStream(operationId).then(async (stream) => {
			if (!this._isOperationActive(operationId)) {
				stopStream(stream);
				throw operationCancelledError();
			}
			try {
				await this._adoptStream(stream, operationId, reason);
				if (!this._isOperationActive(operationId) || stream !== this._stream) {
					throw operationCancelledError();
				}
				return stream;
			} catch (error) {
				if (stream === this._stream) {
					this._releaseStream(`${reason}-adoption-failed`);
				} else if (isLiveStream(stream)) {
					stopStream(stream);
				}
				throw error;
			}
		});
	}

	_requestStream(operationId) {
		if (typeof this._mediaDevices?.getUserMedia !== 'function') {
			return Promise.reject(new ResilientWebcamError(
				ErrorCodes.NOT_SUPPORTED,
				'navigator.mediaDevices.getUserMedia is not available',
				{ recoverable: false },
			));
		}

		let settled = false;
		let timeout = null;
		let resolveRequest;
		let rejectRequest;
		const result = new Promise((resolve, reject) => {
			resolveRequest = resolve;
			rejectRequest = reject;
		});
		const finish = (callback, value) => {
			if (settled) {
				return false;
			}
			settled = true;
			clearTimeout(timeout);
			if (this._pendingRequest?.operationId === operationId) {
				this._pendingRequest = null;
			}
			callback(value);
			return true;
		};
		const cancel = () => finish(rejectRequest, operationCancelledError());
		this._pendingRequest = { operationId, cancel };
		timeout = setTimeout(() => {
			finish(rejectRequest, new ResilientWebcamError(
				ErrorCodes.REQUEST_TIMEOUT,
				`Camera request did not settle within ${this._options.requestTimeoutMs}ms`,
			));
		}, this._options.requestTimeoutMs);

		let mediaPromise;
		try {
			mediaPromise = Promise.resolve(this._mediaDevices.getUserMedia({
				audio: false,
				video: this._options.videoConstraints,
			}));
		} catch (error) {
			mediaPromise = Promise.reject(error);
		}

		mediaPromise.then((stream) => {
			if (settled || !this._isOperationActive(operationId)) {
				stopStream(stream);
				if (!settled) {
					finish(rejectRequest, operationCancelledError());
				}
				return;
			}
			const videoTracks = getVideoTracks(stream);
			if (videoTracks.length === 0) {
				stopStream(stream);
				finish(rejectRequest, new ResilientWebcamError(
					ErrorCodes.NO_VIDEO_TRACK,
					'The media request returned no video track',
				));
				return;
			}
			finish(resolveRequest, stream);
		}, (error) => {
			finish(rejectRequest, normalizeMediaError(error));
		});

		return result;
	}

	async _adoptStream(stream, operationId, reason) {
		if (!this._isOperationActive(operationId)) {
			stopStream(stream);
			throw operationCancelledError();
		}
		if (this._stream && this._stream !== stream) {
			this._releaseStream(`${reason}-replaced`);
		}
		this._stream = stream;
		this._bindTrackListeners(stream);
		this._emit({
			type: 'stream',
			action: 'started',
			reason,
		});
		if (this._video) {
			await this._connectVideo(this._video, stream);
		}
	}

	_executeRestartRequest(reason) {
		this._cancelPendingRequest();
		const operationId = ++this._operationId;
		this._releaseStream(`${reason}-restart`);
		return this._requestAndAdopt(operationId, reason);
	}

	_releaseStream(reason) {
		const stream = this._stream;
		if (!stream) {
			return;
		}
		this._unbindTrackListeners();
		this._stopFrameMonitor();
		this._stream = null;
		if (this._video?.srcObject === stream) {
			try {
				this._video.srcObject = null;
			} catch {
				// Ignore a renderer element being destroyed during stream cleanup.
			}
		}
		stopStream(stream);
		this._emit({
			type: 'stream',
			action: 'stopped',
			reason,
		});
	}

	_stopInternal(reason) {
		const startPromise = this._startPromise;
		const restartPromise = this._restartPromise;
		this._desiredRunning = false;
		this._deferredRecoveryReason = null;
		this._queuedRecoveryReason = null;
		this._cancelRecoveryTimer();
		this._cancelRecoveryReset();
		this._cancelDeviceChangeTimer();
		this._cancelCaptureWaiters();
		this._cancelPendingRequest();
		this._operationId += 1;
		this._unbindGlobalListeners();
		this._releaseStream(reason);
		this._recoveryAttempt = 0;
		if (startPromise && this._startPromise === startPromise) {
			this._startPromise = null;
		}
		if (restartPromise && this._restartPromise === restartPromise) {
			this._restartPromise = null;
		}
	}

	_cancelPendingRequest() {
		const pending = this._pendingRequest;
		this._pendingRequest = null;
		pending?.cancel();
	}

	_bindGlobalListeners() {
		if (this._globalListenersBound) {
			return;
		}
		if (this._options.restartOnDeviceChange) {
			addEventListener(this._mediaDevices, 'devicechange', this._handleDeviceChange);
		}
		if (this._options.pauseWhenHidden) {
			addEventListener(this._document, 'visibilitychange', this._handleVisibilityChange);
		}
		this._globalListenersBound = true;
	}

	_unbindGlobalListeners() {
		if (!this._globalListenersBound) {
			return;
		}
		removeEventListener(this._mediaDevices, 'devicechange', this._handleDeviceChange);
		removeEventListener(this._document, 'visibilitychange', this._handleVisibilityChange);
		this._globalListenersBound = false;
		this._cancelDeviceChangeTimer();
	}

	_bindTrackListeners(stream) {
		this._unbindTrackListeners();
		for (const track of getVideoTracks(stream)) {
			const ended = () => this._triggerRecovery(RecoveryReasons.TRACK_ENDED);
			const muted = () => this._handleTrackMuted(track);
			const unmuted = () => this._handleTrackUnmuted(track);
			addEventListener(track, 'ended', ended);
			addEventListener(track, 'mute', muted);
			addEventListener(track, 'unmute', unmuted);
			this._trackListeners.push({ track, ended, muted, unmuted });
		}
	}

	_unbindTrackListeners() {
		for (const { track, ended, muted, unmuted } of this._trackListeners) {
			removeEventListener(track, 'ended', ended);
			removeEventListener(track, 'mute', muted);
			removeEventListener(track, 'unmute', unmuted);
		}
		this._trackListeners = [];
		for (const timer of this._muteTimers.values()) {
			clearTimeout(timer);
		}
		this._muteTimers.clear();
	}

	_handleTrackMuted(track) {
		if (!this._desiredRunning || this._muteTimers.has(track)) {
			return;
		}
		const timer = setTimeout(() => {
			this._muteTimers.delete(track);
			if (track.muted !== false && track.readyState !== 'ended') {
				this._triggerRecovery(RecoveryReasons.TRACK_MUTED);
			}
		}, this._options.muteGraceMs);
		this._muteTimers.set(track, timer);
	}

	_handleTrackUnmuted(track) {
		const timer = this._muteTimers.get(track);
		if (timer !== undefined) {
			clearTimeout(timer);
			this._muteTimers.delete(track);
		}
		if (this._stream && this._desiredRunning) {
			this._markFrameFresh();
		}
	}

	_handleDeviceChange() {
		if (!this._desiredRunning || this._destroyed) {
			return;
		}
		this._cancelDeviceChangeTimer();
		this._deviceChangeTimer = setTimeout(() => {
			this._deviceChangeTimer = null;
			this._triggerRecovery(RecoveryReasons.DEVICE_CHANGE);
		}, this._options.deviceChangeDebounceMs);
	}

	_cancelDeviceChangeTimer() {
		clearTimeout(this._deviceChangeTimer);
		this._deviceChangeTimer = null;
	}

	_handleVisibilityChange() {
		if (this._document?.hidden) {
			this._stopFrameMonitor();
			return;
		}
		const deferredReason = this._deferredRecoveryReason;
		this._deferredRecoveryReason = null;
		if (
			deferredReason === RecoveryReasons.FRAME_STALLED
			&& this._stream
			&& isLiveStream(this._stream)
		) {
			this._emit({
				type: 'recovery',
				phase: 'cancelled',
				reason: deferredReason,
				details: { cause: 'visibility-restored-with-fresh-deadline' },
			});
			this._setState(WebcamStates.READY, 'visibility-restored');
			this._startFrameMonitor();
			return;
		}
		if (deferredReason) {
			this._scheduleRecovery(deferredReason);
			return;
		}
		if (this._stream && this._desiredRunning) {
			this._startFrameMonitor();
		}
	}

	_triggerRecovery(reason) {
		if (!this._desiredRunning || this._destroyed) {
			return;
		}
		this._cancelRecoveryReset();
		this._lastRecoveryReason = reason;
		if (this._options.pauseWhenHidden && this._document?.hidden) {
			this._deferredRecoveryReason ??= reason;
			this._setState(WebcamStates.RECOVERING, `${reason}-deferred`);
			this._emit({
				type: 'recovery',
				phase: 'deferred',
				reason,
				details: { cause: 'document-hidden' },
			});
			return;
		}
		if (this._restartPromise || this._startPromise) {
			const shouldQueue = [
				RecoveryReasons.TRACK_ENDED,
				RecoveryReasons.TRACK_MUTED,
				RecoveryReasons.FRAME_STALLED,
			].includes(reason);
			if (shouldQueue) {
				this._queuedRecoveryReason ??= reason;
			}
			this._emit({
				type: 'recovery',
				phase: 'coalesced',
				reason,
				details: { queued: shouldQueue },
			});
			return;
		}
		if (this._recoveryTimer) {
			this._emit({
				type: 'recovery',
				phase: 'coalesced',
				reason,
			});
			return;
		}
		this._scheduleRecovery(reason);
	}

	_scheduleRecovery(reason) {
		if (!this._desiredRunning || this._destroyed || this._recoveryTimer) {
			return;
		}
		if (this._recoveryAttempt >= this._options.maxRecoveryAttempts) {
			this._exhaustRecovery(reason, this._lastError);
			return;
		}
		const attempt = this._recoveryAttempt + 1;
		const exponentialDelay = Math.min(
			this._options.recoveryMaxDelayMs,
			this._options.recoveryInitialDelayMs
				* (this._options.recoveryBackoffFactor ** (attempt - 1)),
		);
		const randomResult = Number(this._random());
		const randomValue = Number.isFinite(randomResult)
			? Math.max(0, Math.min(1, randomResult))
			: 0.5;
		const jitterFactor = 1 + (((randomValue * 2) - 1) * this._options.recoveryJitter);
		const delayMs = Math.max(0, Math.round(exponentialDelay * jitterFactor));
		const timer = setTimeout(() => {
			if (this._recoveryTimer !== timer) {
				return;
			}
			this._recoveryTimer = null;
			this._beginAutomaticRecoveryAttempt(reason, attempt);
		}, delayMs);
		this._recoveryTimer = timer;
		this._lastRecoveryReason = reason;
		this._setState(WebcamStates.RECOVERING, reason);
		if (
			!this._desiredRunning
			|| this._destroyed
			|| this._recoveryTimer !== timer
		) {
			return;
		}
		this._emit({
			type: 'recovery',
			phase: 'scheduled',
			reason,
			attempt,
			maxAttempts: this._options.maxRecoveryAttempts,
			delayMs,
		});
	}

	_beginAutomaticRecoveryAttempt(reason, attempt) {
		if (!this._desiredRunning || this._destroyed) {
			return;
		}
		if (this._options.pauseWhenHidden && this._document?.hidden) {
			this._deferredRecoveryReason ??= reason;
			this._emit({
				type: 'recovery',
				phase: 'deferred',
				reason,
				attempt,
				details: { cause: 'document-hidden-before-attempt' },
			});
			return;
		}
		if (this._restartPromise) {
			this._queuedRecoveryReason ??= reason;
			this._emit({
				type: 'recovery',
				phase: 'coalesced',
				reason,
				attempt,
			});
			return;
		}
		this._recoveryAttempt = attempt;
		let retry = false;
		const promise = Promise.resolve()
			.then(() => {
				if (
					this._restartPromise !== promise
					|| !this._desiredRunning
					|| this._destroyed
				) {
					throw operationCancelledError();
				}
				return this._executeRestartRequest(reason);
			})
			.then((stream) => {
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				this._lastError = null;
				if (!isLiveStream(stream)) {
					this._queuedRecoveryReason ??= RecoveryReasons.TRACK_ENDED;
				}
				this._setState(
					this._queuedRecoveryReason ? WebcamStates.RECOVERING : WebcamStates.READY,
					this._queuedRecoveryReason ? `${reason}-still-unhealthy` : `${reason}-recovered`,
				);
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				this._emit({
					type: 'recovery',
					phase: 'succeeded',
					reason,
					attempt,
				});
				if (this._restartPromise !== promise || !this._isAdoptedStreamActive(stream)) {
					throw operationCancelledError();
				}
				if (!this._queuedRecoveryReason) {
					this._scheduleRecoveryReset(reason);
				}
				return stream;
			})
			.catch((error) => {
				const normalized = normalizeMediaError(error);
				if (
					this._restartPromise !== promise
					|| !this._desiredRunning
					|| this._destroyed
				) {
					return null;
				}
				this._lastError = normalized;
				this._emitError(normalized);
				if (
					this._restartPromise !== promise
					|| !this._desiredRunning
					|| this._destroyed
				) {
					return null;
				}
				this._emit({
					type: 'recovery',
					phase: 'failed',
					reason,
					attempt,
					error: normalized,
				});
				if (
					this._restartPromise !== promise
					|| !this._desiredRunning
					|| this._destroyed
				) {
					return null;
				}
				if (!normalized.recoverable || attempt >= this._options.maxRecoveryAttempts) {
					this._exhaustRecovery(reason, normalized);
				} else {
					retry = true;
				}
				return null;
			})
			.finally(() => {
				if (this._restartPromise !== promise) {
					return;
				}
				this._restartPromise = null;
				const queued = this._takeQueuedRecovery();
				if (this._desiredRunning && !this._destroyed) {
					if (queued) {
						this._scheduleRecovery(queued);
					} else if (retry) {
						this._scheduleRecovery(reason);
					}
				}
			});
		this._restartPromise = promise;
		this._emit({
			type: 'recovery',
			phase: 'attempting',
			reason,
			attempt,
			maxAttempts: this._options.maxRecoveryAttempts,
		});
	}

	_takeQueuedRecovery() {
		const reason = this._queuedRecoveryReason;
		this._queuedRecoveryReason = null;
		return reason;
	}

	_drainQueuedRecovery() {
		const reason = this._takeQueuedRecovery();
		if (reason && this._desiredRunning && !this._destroyed) {
			this._scheduleRecovery(reason);
		}
	}

	_waitForRecoveryOutcome() {
		if (this._state === WebcamStates.READY && this._stream && isLiveStream(this._stream)) {
			return Promise.resolve(this._stream);
		}
		if (this._state === WebcamStates.FAILED) {
			return Promise.reject(this._lastError ?? new ResilientWebcamError(
				ErrorCodes.RECOVERY_EXHAUSTED,
				'Camera recovery failed',
				{ recoverable: false },
			));
		}
		if ([WebcamStates.STOPPED, WebcamStates.DESTROYED].includes(this._state)) {
			return Promise.reject(operationCancelledError());
		}
		return new Promise((resolve, reject) => {
			const finish = (callback, value) => {
				this._subscribers.delete(listener);
				callback(value);
			};
			const listener = (event) => {
				if (event.type !== 'status') {
					return;
				}
				if (event.state === WebcamStates.READY && this._stream && isLiveStream(this._stream)) {
					finish(resolve, this._stream);
				} else if (event.state === WebcamStates.FAILED) {
					finish(reject, this._lastError ?? new ResilientWebcamError(
						ErrorCodes.RECOVERY_EXHAUSTED,
						'Camera recovery failed',
						{ recoverable: false },
					));
				} else if ([WebcamStates.STOPPED, WebcamStates.DESTROYED].includes(event.state)) {
					finish(reject, operationCancelledError());
				}
			};
			this._subscribers.add(listener);
		});
	}

	_exhaustRecovery(reason, cause) {
		this._cancelRecoveryTimer();
		this._queuedRecoveryReason = null;
		const error = cause?.code === ErrorCodes.RECOVERY_EXHAUSTED
			? cause
			: new ResilientWebcamError(
				ErrorCodes.RECOVERY_EXHAUSTED,
				`Camera recovery was exhausted after ${this._recoveryAttempt} attempt(s)`,
				{ cause, recoverable: false, details: { reason } },
			);
		this._desiredRunning = false;
		this._lastError = error;
		this._unbindGlobalListeners();
		this._releaseStream(`${reason}-exhausted`);
		if ([WebcamStates.STOPPED, WebcamStates.DESTROYED].includes(this._state)) {
			return;
		}
		this._setState(WebcamStates.FAILED, `${reason}-exhausted`);
		this._emit({
			type: 'recovery',
			phase: 'exhausted',
			reason,
			attempt: this._recoveryAttempt,
			maxAttempts: this._options.maxRecoveryAttempts,
			error,
		});
	}

	_scheduleRecoveryReset(reason) {
		this._cancelRecoveryReset();
		this._recoveryResetTimer = setTimeout(() => {
			this._recoveryResetTimer = null;
			if (!this._desiredRunning || this._state !== WebcamStates.READY) {
				return;
			}
			this._recoveryAttempt = 0;
			this._emit({
				type: 'recovery',
				phase: 'reset',
				reason,
			});
		}, this._options.recoveryResetAfterMs);
	}

	_cancelRecoveryTimer() {
		clearTimeout(this._recoveryTimer);
		this._recoveryTimer = null;
	}

	_cancelRecoveryReset() {
		clearTimeout(this._recoveryResetTimer);
		this._recoveryResetTimer = null;
	}

	_startFrameMonitor() {
		this._stopFrameMonitor();
		const video = this._video;
		if (
			!video
			|| !this._stream
			|| !this._desiredRunning
			|| this._options.frameTimeoutMs === 0
			|| (this._options.pauseWhenHidden && this._document?.hidden)
		) {
			return;
		}

		const token = this._frameMonitorToken;
		this._frameObservedVideo = video;
		this._frameMonitorStartedAt = this._now();
		this._lastObservedMediaTime = Number.isFinite(video.currentTime)
			? video.currentTime
			: null;
		this._frameTimeListener = () => this._observeMediaTime(video, token, true);
		addEventListener(video, 'timeupdate', this._frameTimeListener);

		if (typeof video.requestVideoFrameCallback === 'function') {
			const watchFrame = () => {
				if (!this._isFrameMonitorCurrent(video, token)) {
					return;
				}
				this._markFrameFresh(token);
				this._frameCallbackId = video.requestVideoFrameCallback(watchFrame);
			};
			this._frameCallbackVideo = video;
			this._frameCallbackId = video.requestVideoFrameCallback(watchFrame);
		}

		this._scheduleFramePoll(video, token);
		this._scheduleFrameDeadline(token, this._options.frameTimeoutMs);
	}

	_stopFrameMonitor() {
		this._frameMonitorToken += 1;
		clearTimeout(this._framePollTimer);
		clearTimeout(this._frameDeadlineTimer);
		this._framePollTimer = null;
		this._frameDeadlineTimer = null;
		if (this._frameCallbackId !== null) {
			try {
				this._frameCallbackVideo?.cancelVideoFrameCallback?.(this._frameCallbackId);
			} catch {
				// A detached element can reject callback cancellation.
			}
		}
		this._frameCallbackId = null;
		this._frameCallbackVideo = null;
		if (this._frameObservedVideo && this._frameTimeListener) {
			removeEventListener(this._frameObservedVideo, 'timeupdate', this._frameTimeListener);
		}
		this._frameObservedVideo = null;
		this._frameTimeListener = null;
		this._frameMonitorStartedAt = null;
		this._lastObservedMediaTime = null;
	}

	_isFrameMonitorCurrent(video, token) {
		return token === this._frameMonitorToken
			&& video === this._video
			&& this._stream !== null
			&& this._desiredRunning
			&& !this._destroyed;
	}

	_scheduleFramePoll(video, token) {
		const interval = Math.max(100, Math.min(1000, Math.round(this._options.frameTimeoutMs / 3)));
		this._framePollTimer = setTimeout(() => {
			if (!this._isFrameMonitorCurrent(video, token)) {
				return;
			}
			this._observeMediaTime(video, token, false);
			this._scheduleFramePoll(video, token);
		}, interval);
	}

	_observeMediaTime(video, token, eventIsFresh) {
		if (!this._isFrameMonitorCurrent(video, token)) {
			return;
		}
		const mediaTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
		const advanced = mediaTime !== null
			&& this._lastObservedMediaTime !== null
			&& mediaTime > this._lastObservedMediaTime;
		if (mediaTime !== null) {
			this._lastObservedMediaTime = mediaTime;
		}
		if (advanced || eventIsFresh) {
			this._markFrameFresh(token);
		}
	}

	_markFrameFresh(token = this._frameMonitorToken) {
		const video = this._frameObservedVideo;
		if (
			this._options.frameTimeoutMs === 0
			|| !video
			|| !this._isFrameMonitorCurrent(video, token)
		) {
			return;
		}
		this._lastFrameAt = this._now();
		this._scheduleFrameDeadline(token, this._options.frameTimeoutMs);
	}

	_scheduleFrameDeadline(token, delayMs) {
		clearTimeout(this._frameDeadlineTimer);
		this._frameDeadlineTimer = setTimeout(() => {
			if (token !== this._frameMonitorToken || !this._desiredRunning || !this._stream) {
				return;
			}
			if (this._options.pauseWhenHidden && this._document?.hidden) {
				this._stopFrameMonitor();
				return;
			}
			this._observeMediaTime(this._video, token, false);
			const baseline = this._lastFrameAt ?? this._frameMonitorStartedAt;
			const elapsed = baseline === null ? this._options.frameTimeoutMs : this._now() - baseline;
			if (elapsed < this._options.frameTimeoutMs) {
				this._scheduleFrameDeadline(token, this._options.frameTimeoutMs - elapsed);
				return;
			}
			this._stopFrameMonitor();
			this._triggerRecovery(RecoveryReasons.FRAME_STALLED);
		}, Math.max(0, delayMs));
	}

	async _captureOnce(options, retried) {
		if (this._state !== WebcamStates.READY || !this._stream || !this._video) {
			throw new ResilientWebcamError(
				ErrorCodes.VIDEO_NOT_READY,
				'capture() requires a ready stream and an attached video element',
			);
		}
		const video = this._video;
		const stream = this._stream;
		await this._waitForVideoFrame(video, options.readyTimeoutMs);
		if (video !== this._video || stream !== this._stream || this._state !== WebcamStates.READY) {
			throw operationCancelledError();
		}

		const { width, height } = resolveCaptureSize(
			video.videoWidth,
			video.videoHeight,
			options.width,
			options.height,
		);
		const canvas = this._createCanvas(width, height);
		const context = canvas.getContext?.('2d', { willReadFrequently: options.blackFrameDetection !== false });
		if (!context) {
			throw new ResilientWebcamError(
				ErrorCodes.CAPTURE_FAILED,
				'Unable to create a 2D canvas context for capture',
			);
		}
		context.drawImage(video, 0, 0, width, height);

		let analysis = null;
		if (options.blackFrameDetection !== false) {
			const pixels = context.getImageData(0, 0, width, height).data;
			const analysisOptions = options.blackFrameDetection === true
				? {}
				: options.blackFrameDetection;
			analysis = analyzeFramePixels(pixels, analysisOptions);
		}
		const blob = await this._canvasToBlob(
			canvas,
			options.type,
			options.quality,
			options.encodeTimeoutMs,
		);
		if (
			this._destroyed
			|| video !== this._video
			|| stream !== this._stream
			|| this._state !== WebcamStates.READY
		) {
			throw operationCancelledError();
		}
		const result = Object.freeze({
			blob,
			width,
			height,
			type: blob.type || options.type,
			nearBlack: analysis?.nearBlack ?? false,
			analysis,
			retried,
			capturedAt: this._now(),
		});

		if (result.nearBlack && options.restartAndRetryOnBlack && !retried) {
			this._emit({
				type: 'capture',
				phase: 'black-frame-detected',
				width,
				height,
				captureType: result.type,
				nearBlack: true,
				analysis,
			});
			await this.restart(RecoveryReasons.BLACK_FRAME);
			return this._captureOnce(options, true);
		}

		this._emit({
			type: 'capture',
			phase: 'completed',
			width,
			height,
			captureType: result.type,
			nearBlack: result.nearBlack,
			retried,
			analysis: analysis ?? undefined,
		});
		return result;
	}

	_waitForVideoFrame(video, timeoutMs) {
		if (video.videoWidth > 0 && video.videoHeight > 0) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			let timeout;
			const events = ['loadedmetadata', 'loadeddata', 'canplay', 'resize'];
			const cleanup = () => {
				clearTimeout(timeout);
				for (const event of events) {
					removeEventListener(video, event, check);
				}
				this._captureWaiters.delete(cancel);
			};
			const finish = (callback, value) => {
				cleanup();
				callback(value);
			};
			const check = () => {
				if (video.videoWidth > 0 && video.videoHeight > 0) {
					finish(resolve);
				}
			};
			const cancel = () => finish(reject, operationCancelledError());
			this._captureWaiters.add(cancel);
			for (const event of events) {
				addEventListener(video, event, check);
			}
			timeout = setTimeout(() => {
				finish(reject, new ResilientWebcamError(
					ErrorCodes.VIDEO_NOT_READY,
					`The video did not produce capture dimensions within ${timeoutMs}ms`,
				));
			}, timeoutMs);
		});
	}

	_cancelCaptureWaiters() {
		for (const cancel of [...this._captureWaiters]) {
			cancel();
		}
		this._captureWaiters.clear();
	}

	_createCanvas(width, height) {
		let canvas;
		if (this._canvasFactory) {
			canvas = this._canvasFactory(width, height);
		} else if (typeof this._document?.createElement === 'function') {
			canvas = this._document.createElement('canvas');
		} else if (typeof globalThis.OffscreenCanvas === 'function') {
			canvas = new globalThis.OffscreenCanvas(width, height);
		}
		if (!canvas) {
			throw new ResilientWebcamError(
				ErrorCodes.NOT_SUPPORTED,
				'Canvas capture is not available in this environment',
				{ recoverable: false },
			);
		}
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}

	_canvasToBlob(canvas, type, quality, timeoutMs) {
		let conversion;
		if (typeof canvas.convertToBlob === 'function') {
			conversion = Promise.resolve(canvas.convertToBlob({ type, quality }));
		} else if (typeof canvas.toBlob !== 'function') {
			return Promise.reject(new ResilientWebcamError(
				ErrorCodes.NOT_SUPPORTED,
				'Canvas Blob export is not available in this environment',
				{ recoverable: false },
			));
		} else {
			conversion = new Promise((resolve, reject) => {
				canvas.toBlob((blob) => {
					if (blob) {
						resolve(blob);
					} else {
						reject(new ResilientWebcamError(
							ErrorCodes.CAPTURE_FAILED,
							'Canvas returned an empty capture',
						));
					}
				}, type, quality);
			});
		}
		return this._withTimeout(
			conversion,
			timeoutMs,
			() => new ResilientWebcamError(
				ErrorCodes.CAPTURE_FAILED,
				`Canvas encoding did not settle within ${timeoutMs}ms`,
			),
		);
	}

	_withTimeout(promise, timeoutMs, createError) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback, value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				callback(value);
			};
			const timeout = setTimeout(() => finish(reject, createError()), timeoutMs);
			Promise.resolve(promise).then(
				(value) => finish(resolve, value),
				(error) => finish(reject, error),
			);
		});
	}
}

export function createResilientWebcam(options) {
	return new ResilientWebcam(options);
}
