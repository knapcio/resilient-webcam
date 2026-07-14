import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ErrorCodes,
	ResilientWebcam,
	WebcamStates,
} from '../src/index.js';
import {
	FakeDocument,
	FakeMediaDevices,
	FakeStream,
	FakeTrack,
	FakeVideo,
	deferred,
	delay,
	namedError,
	waitFor,
} from './helpers.js';

function recoveryOptions(overrides = {}) {
	return {
		frameTimeoutMs: 0,
		recoveryInitialDelayMs: 0,
		recoveryMaxDelayMs: 0,
		recoveryJitter: 0,
		recoveryResetAfterMs: 1000,
		...overrides,
	};
}

test('start is single-flight and the controller owns and stops one stream', async () => {
	const request = deferred();
	const track = new FakeTrack();
	const stream = new FakeStream([track]);
	const mediaDevices = new FakeMediaDevices([() => request.promise]);
	const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });

	const firstStart = camera.start();
	const secondStart = camera.start();
	assert.strictEqual(secondStart, firstStart);
	await delay(0);
	assert.equal(mediaDevices.calls, 1);

	request.resolve(stream);
	assert.strictEqual(await firstStart, stream);
	assert.equal(camera.state, WebcamStates.READY);
	assert.deepEqual(mediaDevices.constraints, [{ audio: false, video: true }]);

	camera.stop();
	assert.equal(camera.state, WebcamStates.STOPPED);
	assert.equal(camera.stream, null);
	assert.equal(track.stopCalls, 1);
});

test('moving attachment A to B reuses the stream and ignores stale frame callbacks', async () => {
	let now = 10;
	const stream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([stream]);
	const videoA = new FakeVideo();
	const videoB = new FakeVideo();
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 1000,
		now: () => now,
	});

	camera.attach(videoA);
	await camera.start();
	const staleFrameCallback = videoA.firstFrameCallback();
	assert.equal(typeof staleFrameCallback, 'function');

	camera.detach();
	camera.attach(videoB);
	await waitFor(() => typeof videoB.firstFrameCallback() === 'function');
	assert.equal(mediaDevices.calls, 1);
	assert.strictEqual(videoB.srcObject, stream);
	assert.equal(videoA.srcObject, null);

	now = 20;
	staleFrameCallback(0, { mediaTime: 1 });
	assert.equal(camera.status.lastFrameAt, null);

	now = 30;
	videoB.presentFrame();
	assert.equal(camera.status.lastFrameAt, 30);
	camera.destroy();
});

test('an ended track triggers one automatic recovery and replaces the stream', async () => {
	const firstTrack = new FakeTrack({ deviceId: 'first' });
	const secondTrack = new FakeTrack({ deviceId: 'second' });
	const firstStream = new FakeStream([firstTrack]);
	const secondStream = new FakeStream([secondTrack]);
	const mediaDevices = new FakeMediaDevices([firstStream, secondStream]);
	const events = [];
	const camera = new ResilientWebcam({
		mediaDevices,
		onEvent: (event) => events.push(event),
		...recoveryOptions(),
	});

	await camera.start();
	firstTrack.end();
	await waitFor(() => camera.stream === secondStream && camera.state === WebcamStates.READY);

	assert.equal(mediaDevices.calls, 2);
	assert.equal(firstTrack.stopCalls, 1);
	assert.equal(camera.status.deviceId, 'second');
	assert.ok(events.some((event) => (
		event.type === 'recovery'
		&& event.phase === 'succeeded'
		&& event.reason === 'track-ended'
	)));
	camera.destroy();
});

test('unmute inside the grace period cancels mute recovery', async () => {
	const track = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([new FakeStream([track])]);
	const camera = new ResilientWebcam({
		mediaDevices,
		muteGraceMs: 30,
		frameTimeoutMs: 1000,
		recoveryInitialDelayMs: 0,
		recoveryJitter: 0,
	});

	await camera.start();
	track.mute();
	await delay(10);
	track.unmute();
	await delay(35);

	assert.equal(mediaDevices.calls, 1);
	assert.equal(camera.state, WebcamStates.READY);
	camera.destroy();
});

test('a persistently muted track recovers after the grace period', async () => {
	const firstTrack = new FakeTrack();
	const secondStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([firstTrack]),
		secondStream,
	]);
	const camera = new ResilientWebcam({
		mediaDevices,
		muteGraceMs: 15,
		...recoveryOptions(),
	});

	await camera.start();
	firstTrack.mute();
	await waitFor(() => camera.stream === secondStream);

	assert.equal(mediaDevices.calls, 2);
	assert.equal(camera.status.lastRecoveryReason, 'track-muted');
	camera.destroy();
});

test('device changes are debounced and overlapping recovery signals coalesce', async () => {
	const replacementRequest = deferred();
	const firstTrack = new FakeTrack();
	const replacementStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([firstTrack]),
		() => replacementRequest.promise,
	]);
	const events = [];
	const camera = new ResilientWebcam({
		mediaDevices,
		deviceChangeDebounceMs: 8,
		onEvent: (event) => events.push(event),
		...recoveryOptions(),
	});

	await camera.start();
	firstTrack.end();
	mediaDevices.dispatch('devicechange');
	mediaDevices.dispatch('devicechange');
	mediaDevices.dispatch('devicechange');
	await waitFor(() => mediaDevices.calls === 2);
	await delay(15);

	assert.equal(mediaDevices.calls, 2);
	assert.ok(events.some((event) => (
		event.type === 'recovery'
		&& event.phase === 'coalesced'
		&& event.reason === 'device-change'
	)));

	replacementRequest.resolve(replacementStream);
	await waitFor(() => camera.stream === replacementStream && camera.state === WebcamStates.READY);
	assert.equal(mediaDevices.calls, 2);
	camera.destroy();
});

test('a hanging request times out and a late stream is stopped', async () => {
	const request = deferred();
	const lateTrack = new FakeTrack();
	const lateStream = new FakeStream([lateTrack]);
	const mediaDevices = new FakeMediaDevices([() => request.promise]);
	const camera = new ResilientWebcam({
		mediaDevices,
		requestTimeoutMs: 15,
		frameTimeoutMs: 0,
	});

	await assert.rejects(camera.start(), (error) => {
		assert.equal(error.code, ErrorCodes.REQUEST_TIMEOUT);
		return true;
	});
	assert.equal(camera.state, WebcamStates.FAILED);

	request.resolve(lateStream);
	await waitFor(() => lateTrack.stopCalls === 1);
	assert.equal(camera.stream, null);
});

for (const action of ['stop', 'destroy']) {
	test(`${action} during a failed recovery cancels the remaining retries`, async () => {
		const initialTrack = new FakeTrack();
		const unusedStream = new FakeStream();
		const mediaDevices = new FakeMediaDevices([
			new FakeStream([initialTrack]),
			namedError('NotReadableError'),
			unusedStream,
		]);
		const camera = new ResilientWebcam({
			mediaDevices,
			...recoveryOptions({
				maxRecoveryAttempts: 3,
				recoveryInitialDelayMs: 5,
				recoveryMaxDelayMs: 5,
			}),
		});
		camera.subscribe((event) => {
			if (event.type === 'recovery' && event.phase === 'failed') {
				camera[action]();
			}
		});

		await camera.start();
		initialTrack.end();
		await waitFor(() => (
			camera.state === (action === 'stop' ? WebcamStates.STOPPED : WebcamStates.DESTROYED)
		));
		await delay(30);

		assert.equal(mediaDevices.calls, 2);
		assert.equal(unusedStream.getTracks()[0].stopCalls, 0);
	});
}

test('advancing currentTime keeps an offscreen video healthy without frame callbacks', async () => {
	const mediaDevices = new FakeMediaDevices([new FakeStream(), new FakeStream()]);
	const video = new FakeVideo();
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 25,
		recoveryInitialDelayMs: 0,
		recoveryJitter: 0,
	});
	camera.attach(video);
	await camera.start();

	for (let frame = 0; frame < 6; frame += 1) {
		await delay(12);
		video.currentTime += 0.1;
	}

	assert.equal(mediaDevices.calls, 1);
	assert.equal(camera.state, WebcamStates.READY);
	assert.equal(video.pendingFrameCallbacks.size, 1);
	camera.destroy();
});

test('visibility restoration starts a fresh frame deadline', async () => {
	const document = new FakeDocument();
	const mediaDevices = new FakeMediaDevices([new FakeStream(), new FakeStream()]);
	const video = new FakeVideo();
	const camera = new ResilientWebcam({
		mediaDevices,
		document,
		frameTimeoutMs: 40,
		recoveryInitialDelayMs: 0,
		recoveryMaxDelayMs: 0,
		recoveryJitter: 0,
	});
	camera.attach(video);
	await camera.start();

	await delay(20);
	document.setHidden(true);
	await delay(55);
	assert.equal(mediaDevices.calls, 1);

	document.setHidden(false);
	await delay(25);
	assert.equal(mediaDevices.calls, 1, 'visibility restoration must not reuse the old deadline');
	await waitFor(() => mediaDevices.calls === 2, { timeoutMs: 100 });
	camera.destroy();
});
