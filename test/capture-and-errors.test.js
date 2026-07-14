import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ErrorCodes,
	ResilientWebcam,
	WebcamStates,
	normalizeMediaError,
} from '../src/index.js';
import {
	FakeMediaDevices,
	FakeStream,
	FakeTrack,
	FakeVideo,
	canvasFactory,
	delay,
	namedError,
	pixelData,
	waitFor,
} from './helpers.js';

function captureCamera({ frames, streams = [new FakeStream()], counters = {} }) {
	const mediaDevices = new FakeMediaDevices(streams);
	const video = new FakeVideo({ width: 2, height: 2 });
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		canvasFactory: canvasFactory(frames, counters),
	});
	camera.attach(video);
	return { camera, mediaDevices, video, counters };
}

test('a black capture restarts once and returns the good retry', async () => {
	const counters = {};
	const firstTrack = new FakeTrack();
	const secondTrack = new FakeTrack();
	const { camera, mediaDevices } = captureCamera({
		frames: [pixelData(0), pixelData(255)],
		streams: [new FakeStream([firstTrack]), new FakeStream([secondTrack])],
		counters,
	});
	await camera.start();

	const result = await camera.capture({
		blackFrameDetection: true,
		restartAndRetryOnBlack: true,
	});

	assert.equal(result.nearBlack, false);
	assert.equal(result.retried, true);
	assert.equal(result.analysis.nearBlack, false);
	assert.equal(mediaDevices.calls, 2);
	assert.equal(firstTrack.stopCalls, 1);
	assert.equal(counters.getImageData, 2);
	assert.equal(counters.toBlob, 2);
	camera.destroy();
});

test('a second black capture is returned without a third request', async () => {
	const counters = {};
	const { camera, mediaDevices } = captureCamera({
		frames: [pixelData(0), pixelData(0)],
		streams: [new FakeStream(), new FakeStream(), new FakeStream()],
		counters,
	});
	await camera.start();

	const result = await camera.capture({
		blackFrameDetection: true,
		restartAndRetryOnBlack: true,
	});

	assert.equal(result.nearBlack, true);
	assert.equal(result.retried, true);
	assert.equal(mediaDevices.calls, 2);
	assert.equal(counters.created, 2);
	assert.equal(counters.getImageData, 2);
	camera.destroy();
});

test('disabled black-frame detection neither reads pixels nor restarts', async () => {
	const counters = {};
	const { camera, mediaDevices } = captureCamera({
		frames: [pixelData(0)],
		streams: [new FakeStream(), new FakeStream()],
		counters,
	});
	await camera.start();

	const result = await camera.capture({
		blackFrameDetection: false,
		restartAndRetryOnBlack: true,
	});

	assert.equal(result.nearBlack, false);
	assert.equal(result.analysis, null);
	assert.equal(result.retried, false);
	assert.equal(counters.getImageData, 0);
	assert.equal(mediaDevices.calls, 1);
	camera.destroy();
});

test('platform media errors are normalized with stable codes and recoverability', () => {
	const denied = normalizeMediaError(namedError('NotAllowedError', 'Camera denied'));
	assert.equal(denied.code, ErrorCodes.PERMISSION_DENIED);
	assert.equal(denied.recoverable, false);
	assert.equal(denied.message, 'Camera denied');

	const overconstrainedSource = namedError('OverconstrainedError', 'Bad width');
	overconstrainedSource.constraint = 'width';
	const overconstrained = normalizeMediaError(overconstrainedSource);
	assert.equal(overconstrained.code, ErrorCodes.CONSTRAINT_UNSATISFIED);
	assert.equal(overconstrained.recoverable, false);
	assert.deepEqual(overconstrained.details, { constraint: 'width' });

	const busy = normalizeMediaError(namedError('NotReadableError'));
	assert.equal(busy.code, ErrorCodes.DEVICE_BUSY);
	assert.equal(busy.recoverable, true);

	const unknown = normalizeMediaError(new Error('Driver disappeared'));
	assert.equal(unknown.code, ErrorCodes.UNKNOWN);
	assert.equal(unknown.recoverable, true);
	assert.equal(unknown.cause.message, 'Driver disappeared');
});

test('automatic recovery is bounded and ends with RECOVERY_EXHAUSTED', async () => {
	const firstTrack = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([firstTrack]),
		namedError('NotReadableError', 'busy one'),
		namedError('NotReadableError', 'busy two'),
		new FakeStream(),
	]);
	const events = [];
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		maxRecoveryAttempts: 2,
		recoveryInitialDelayMs: 0,
		recoveryMaxDelayMs: 0,
		recoveryJitter: 0,
		onEvent: (event) => events.push(event),
	});
	await camera.start();

	firstTrack.end();
	await waitFor(() => camera.state === WebcamStates.FAILED);
	await delay(15);

	assert.equal(mediaDevices.calls, 3);
	assert.equal(camera.status.desiredRunning, false);
	assert.equal(camera.status.recoveryAttempt, 2);
	assert.equal(camera.status.lastError.code, ErrorCodes.RECOVERY_EXHAUSTED);
	assert.equal(camera.status.lastError.recoverable, false);
	assert.equal(camera.status.lastError.details.reason, 'track-ended');
	assert.ok(events.some((event) => (
		event.type === 'recovery'
		&& event.phase === 'exhausted'
		&& event.attempt === 2
	)));
});

test('invalid bounds fail before camera access', () => {
	assert.throws(
		() => new ResilientWebcam({ maxRecoveryAttempts: 0 }),
		(error) => error.code === ErrorCodes.INVALID_ARGUMENT,
	);
	assert.throws(
		() => new ResilientWebcam({ recoveryJitter: 1.1 }),
		(error) => error.code === ErrorCodes.INVALID_ARGUMENT,
	);
});
