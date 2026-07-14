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

function automaticRecoveryOptions(overrides = {}) {
	return {
		frameTimeoutMs: 0,
		recoveryInitialDelayMs: 0,
		recoveryMaxDelayMs: 0,
		recoveryJitter: 0,
		recoveryResetAfterMs: 1000,
		...overrides,
	};
}

function listenerCount(target, type) {
	return target.listeners.get(type)?.size ?? 0;
}

test('onStatus can reenter start during starting without opening a second request', async () => {
	const stream = new FakeStream();
	const request = deferred();
	const mediaDevices = new FakeMediaDevices([() => request.promise]);
	let camera;
	let reentrantStart;
	camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		onStatus: (event) => {
			if (event.state === WebcamStates.STARTING) {
				reentrantStart = camera.start();
			}
		},
	});

	const initialStart = camera.start();
	assert.strictEqual(reentrantStart, initialStart);
	await delay(0);
	assert.equal(mediaDevices.calls, 1);

	request.resolve(stream);
	assert.strictEqual(await initialStart, stream);
	assert.strictEqual(await reentrantStart, stream);
	assert.equal(mediaDevices.calls, 1);
	camera.destroy();
});

test('a stream-stopped callback cannot restart while destroy is cleaning up', async () => {
	const document = new FakeDocument();
	const mediaDevices = new FakeMediaDevices([new FakeStream(), new FakeStream()]);
	let reentrantStart;
	const camera = new ResilientWebcam({
		mediaDevices,
		document,
		frameTimeoutMs: 0,
	});
	camera.subscribe((event) => {
		if (event.type === 'stream' && event.action === 'stopped') {
			reentrantStart = camera.start();
		}
	});
	await camera.start();
	assert.equal(listenerCount(mediaDevices, 'devicechange'), 1);
	assert.equal(listenerCount(document, 'visibilitychange'), 1);

	camera.destroy();
	assert.equal(camera.state, WebcamStates.DESTROYED);
	assert.equal(mediaDevices.calls, 1);
	assert.equal(listenerCount(mediaDevices, 'devicechange'), 0);
	assert.equal(listenerCount(document, 'visibilitychange'), 0);
	await assert.rejects(reentrantStart, (error) => {
		assert.equal(error.code, ErrorCodes.DESTROYED);
		return true;
	});
	await delay(10);
	assert.equal(mediaDevices.calls, 1);
});

test('a replacement ending during adoption queues bounded recovery without becoming ready', async () => {
	const initialTrack = new FakeTrack({ deviceId: 'initial' });
	const endedReplacementTrack = new FakeTrack({ deviceId: 'ended-replacement' });
	const healthyTrack = new FakeTrack({ deviceId: 'healthy' });
	const initialStream = new FakeStream([initialTrack]);
	const endedReplacement = new FakeStream([endedReplacementTrack]);
	const healthyReplacement = new FakeStream([healthyTrack]);
	const mediaDevices = new FakeMediaDevices([
		initialStream,
		endedReplacement,
		healthyReplacement,
	]);
	const readyTrackStates = [];
	let startedStreams = 0;
	let camera;
	camera = new ResilientWebcam({
		mediaDevices,
		maxRecoveryAttempts: 2,
		...automaticRecoveryOptions(),
		onEvent: (event) => {
			if (event.type === 'stream' && event.action === 'started') {
				startedStreams += 1;
				if (startedStreams === 2) {
					endedReplacementTrack.end();
				}
			}
			if (event.type === 'status' && event.state === WebcamStates.READY) {
				readyTrackStates.push(camera.stream?.getVideoTracks()[0]?.readyState);
			}
		},
	});

	await camera.start();
	initialTrack.end();
	await waitFor(() => camera.stream === healthyReplacement && camera.state === WebcamStates.READY);

	assert.equal(mediaDevices.calls, 3);
	assert.equal(endedReplacementTrack.stopCalls, 1);
	assert.deepEqual(readyTrackStates, ['live', 'live']);
	assert.equal(camera.status.deviceId, 'healthy');
	camera.destroy();
});

test('a scheduled recovery waits if the document becomes hidden before its timer fires', async () => {
	const document = new FakeDocument();
	const initialTrack = new FakeTrack();
	const replacement = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		replacement,
	]);
	const camera = new ResilientWebcam({
		mediaDevices,
		document,
		...automaticRecoveryOptions({
			recoveryInitialDelayMs: 25,
			recoveryMaxDelayMs: 25,
		}),
	});
	await camera.start();

	initialTrack.end();
	await delay(5);
	document.setHidden(true);
	await delay(35);
	assert.equal(mediaDevices.calls, 1);
	assert.equal(camera.state, WebcamStates.RECOVERING);

	document.setHidden(false);
	await waitFor(() => camera.stream === replacement && camera.state === WebcamStates.READY);
	assert.equal(mediaDevices.calls, 2);
	camera.destroy();
});

test('a never-settling video.play is bounded by playTimeoutMs', async () => {
	const track = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([new FakeStream([track])]);
	const video = new FakeVideo();
	video.play = () => new Promise(() => {});
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		playTimeoutMs: 15,
	});
	camera.attach(video);

	await assert.rejects(camera.start(), (error) => {
		assert.equal(error.code, ErrorCodes.VIDEO_PLAY_FAILED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.FAILED);
	assert.equal(camera.stream, null);
	assert.equal(track.stopCalls, 1);
	assert.equal(mediaDevices.calls, 1);
});

test('destroy during delayed canvas encoding rejects capture as cancelled', async () => {
	let finishEncoding;
	const mediaDevices = new FakeMediaDevices([new FakeStream()]);
	const video = new FakeVideo({ width: 2, height: 2 });
	const camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		canvasFactory: () => ({
			getContext: () => ({ drawImage() {} }),
			toBlob: (callback) => {
				finishEncoding = callback;
			},
		}),
	});
	camera.attach(video);
	await camera.start();

	const capture = camera.capture({ encodeTimeoutMs: 100 });
	await waitFor(() => typeof finishEncoding === 'function');
	camera.destroy();
	finishEncoding(new Blob(['late capture'], { type: 'image/jpeg' }));

	await assert.rejects(capture, (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.DESTROYED);
});

test('public restart during successful automatic recovery resolves a MediaStream, never null', async () => {
	const replacementRequest = deferred();
	const initialTrack = new FakeTrack();
	const replacement = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		() => replacementRequest.promise,
	]);
	const camera = new ResilientWebcam({
		mediaDevices,
		...automaticRecoveryOptions(),
	});
	await camera.start();

	initialTrack.end();
	await waitFor(() => mediaDevices.calls === 2);
	const publicRestart = camera.restart();
	replacementRequest.resolve(replacement);

	const result = await publicRestart;
	assert.strictEqual(result, replacement);
	assert.notEqual(result, null);
	assert.equal(camera.state, WebcamStates.READY);
	camera.destroy();
});

test('public restart during failed automatic recovery rejects instead of resolving null', async () => {
	const replacementRequest = deferred();
	const initialTrack = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		() => replacementRequest.promise,
	]);
	const camera = new ResilientWebcam({
		mediaDevices,
		maxRecoveryAttempts: 1,
		...automaticRecoveryOptions(),
	});
	await camera.start();

	initialTrack.end();
	await waitFor(() => mediaDevices.calls === 2);
	const publicRestart = camera.restart();
	replacementRequest.reject(namedError('NotReadableError', 'Camera stayed busy'));

	await assert.rejects(publicRestart, (error) => {
		assert.equal(error.code, ErrorCodes.RECOVERY_EXHAUSTED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.FAILED);
});
