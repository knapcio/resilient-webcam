import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ErrorCodes,
	RecoveryReasons,
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

for (const action of ['stop', 'destroy']) {
	test(`${action} from stream-stopped prevents a replacement camera request`, async () => {
		const initialTrack = new FakeTrack();
		const unusedReplacement = new FakeStream();
		const mediaDevices = new FakeMediaDevices([
			new FakeStream([initialTrack]),
			unusedReplacement,
		]);
		let acted = false;
		const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });
		camera.subscribe((event) => {
			if (
				!acted
				&& event.type === 'stream'
				&& event.action === 'stopped'
				&& event.reason === 'manual-restart'
			) {
				acted = true;
				camera[action]();
			}
		});
		await camera.start();

		await assert.rejects(camera.restart(), (error) => {
			assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
			return true;
		});

		assert.equal(mediaDevices.calls, 1);
		assert.equal(initialTrack.stopCalls, 1);
		assert.equal(unusedReplacement.getTracks()[0].stopCalls, 0);
		assert.equal(
			camera.state,
			action === 'stop' ? WebcamStates.STOPPED : WebcamStates.DESTROYED,
		);
		if (action === 'stop') {
			camera.destroy();
		}
	});
}

test('stop while replacement video.play is pending cancels adoption', async () => {
	const playGate = deferred();
	const initialTrack = new FakeTrack();
	const replacementTrack = new FakeTrack();
	const replacement = new FakeStream([replacementTrack]);
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		replacement,
	]);
	const video = new FakeVideo();
	let playCalls = 0;
	video.play = () => {
		playCalls += 1;
		return playCalls === 1 ? Promise.resolve() : playGate.promise;
	};
	const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });
	camera.attach(video);
	await camera.start();

	const restarting = camera.restart();
	await waitFor(() => camera.stream === replacement && playCalls === 2);
	camera.stop();
	playGate.resolve();

	await assert.rejects(restarting, (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.STOPPED);
	assert.equal(camera.stream, null);
	assert.equal(replacementTrack.stopCalls, 1);
	camera.destroy();
});

test('destroy from stream-started rejects adoption without restoring ready', async () => {
	const replacementTrack = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream(),
		new FakeStream([replacementTrack]),
	]);
	let startedStreams = 0;
	let camera;
	camera = new ResilientWebcam({
		mediaDevices,
		frameTimeoutMs: 0,
		onEvent: (event) => {
			if (event.type === 'stream' && event.action === 'started') {
				startedStreams += 1;
				if (startedStreams === 2) {
					camera.destroy();
				}
			}
		},
	});
	await camera.start();

	await assert.rejects(camera.restart(), (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.DESTROYED);
	assert.equal(camera.stream, null);
	assert.equal(replacementTrack.stopCalls, 1);
});

for (const scenario of [
	{ name: 'without an attached video', attach: false, frameTimeoutMs: 15 },
	{ name: 'with a disabled watchdog', attach: true, frameTimeoutMs: 0 },
]) {
	test(`track unmute does not arm frame monitoring ${scenario.name}`, async () => {
		const track = new FakeTrack();
		const unexpectedReplacement = new FakeStream();
		const mediaDevices = new FakeMediaDevices([
			new FakeStream([track]),
			unexpectedReplacement,
		]);
		const camera = new ResilientWebcam({
			mediaDevices,
			frameTimeoutMs: scenario.frameTimeoutMs,
			recoveryInitialDelayMs: 0,
			recoveryMaxDelayMs: 0,
			recoveryJitter: 0,
		});
		if (scenario.attach) {
			camera.attach(new FakeVideo());
		}
		try {
			await camera.start();
			track.unmute();
			await delay(25);
			assert.equal(camera.status.lastFrameAt, null);
			assert.equal(mediaDevices.calls, 1);
			assert.equal(unexpectedReplacement.getTracks()[0].stopCalls, 0);
		} finally {
			camera.destroy();
		}
	});
}

test('start immediately after stop uses a new flight', async () => {
	const cancelledRequest = deferred();
	const lateTrack = new FakeTrack();
	const freshStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		() => cancelledRequest.promise,
		freshStream,
	]);
	const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });

	const cancelledStart = camera.start();
	const cancelledOutcome = assert.rejects(cancelledStart, (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	camera.stop();
	const freshStart = camera.start();

	assert.notStrictEqual(freshStart, cancelledStart);
	assert.strictEqual(await freshStart, freshStream);
	await cancelledOutcome;
	assert.equal(mediaDevices.calls, 2);
	assert.equal(camera.state, WebcamStates.READY);

	cancelledRequest.resolve(new FakeStream([lateTrack]));
	await waitFor(() => lateTrack.stopCalls === 1);
	camera.destroy();
});

test('restart immediately after stopping a recovery does not wait on the cancelled flight', async () => {
	const cancelledRequest = deferred();
	const lateTrack = new FakeTrack();
	const freshStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream(),
		() => cancelledRequest.promise,
		freshStream,
	]);
	const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });
	await camera.start();

	const cancelledRestart = camera.restart();
	const cancelledOutcome = assert.rejects(cancelledRestart, (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	await waitFor(() => mediaDevices.calls === 2);
	camera.stop();
	const freshRestart = camera.restart();

	assert.notStrictEqual(freshRestart, cancelledRestart);
	assert.strictEqual(await freshRestart, freshStream);
	await cancelledOutcome;
	assert.equal(mediaDevices.calls, 3);
	assert.equal(camera.state, WebcamStates.READY);

	cancelledRequest.resolve(new FakeStream([lateTrack]));
	await waitFor(() => lateTrack.stopCalls === 1);
	camera.destroy();
});

test('a stopped restart microtask cannot cancel the start that superseded it', async () => {
	const freshStream = new FakeStream();
	const unusedStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream(),
		freshStream,
		unusedStream,
	]);
	const camera = new ResilientWebcam({ mediaDevices, frameTimeoutMs: 0 });
	await camera.start();

	const cancelledRestart = camera.restart();
	const cancelledOutcome = assert.rejects(cancelledRestart, (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	camera.stop();
	const freshStart = camera.start();

	assert.strictEqual(await freshStart, freshStream);
	await cancelledOutcome;
	await delay(0);
	assert.equal(mediaDevices.calls, 2);
	assert.equal(camera.stream, freshStream);
	assert.equal(unusedStream.getTracks()[0].stopCalls, 0);
	camera.destroy();
});

test('restart rejects when a coalesced observer already stopped recovery', async () => {
	const recoveryRequest = deferred();
	const lateTrack = new FakeTrack();
	const initialTrack = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		() => recoveryRequest.promise,
	]);
	let stopOnCoalesced = false;
	const camera = new ResilientWebcam({
		mediaDevices,
		...automaticRecoveryOptions(),
		onRecovery: (event) => {
			if (stopOnCoalesced && event.phase === 'coalesced') {
				camera.stop();
			}
		},
	});
	await camera.start();
	initialTrack.end();
	await waitFor(() => mediaDevices.calls === 2);

	stopOnCoalesced = true;
	await assert.rejects(camera.restart(), (error) => {
		assert.equal(error.code, ErrorCodes.OPERATION_CANCELLED);
		return true;
	});
	assert.equal(camera.state, WebcamStates.STOPPED);

	recoveryRequest.resolve(new FakeStream([lateTrack]));
	await waitFor(() => lateTrack.stopCalls === 1);
	camera.destroy();
});

test('visibility restoration retries a deferred frame stall after its stream was released', async () => {
	const document = new FakeDocument();
	const recoveredStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream(),
		namedError('NotReadableError', 'Temporary camera failure'),
		recoveredStream,
	]);
	const events = [];
	const camera = new ResilientWebcam({
		mediaDevices,
		document,
		frameTimeoutMs: 15,
		maxRecoveryAttempts: 2,
		recoveryInitialDelayMs: 0,
		recoveryMaxDelayMs: 0,
		recoveryJitter: 0,
		onRecovery: (event) => {
			events.push(event);
			if (
				event.phase === 'failed'
				&& event.reason === RecoveryReasons.FRAME_STALLED
			) {
				document.setHidden(true);
			}
		},
	});
	camera.attach(new FakeVideo());
	await camera.start();

	await waitFor(() => events.some((event) => (
		event.phase === 'deferred'
		&& event.reason === RecoveryReasons.FRAME_STALLED
		&& event.details?.cause === 'document-hidden-before-attempt'
	)), { timeoutMs: 300 });
	assert.equal(camera.stream, null);
	assert.equal(camera.state, WebcamStates.RECOVERING);

	document.setHidden(false);
	await waitFor(() => camera.stream === recoveredStream && camera.state === WebcamStates.READY);
	assert.equal(mediaDevices.calls, 3);
	assert.equal(events.some((event) => (
		event.phase === 'cancelled'
		&& event.reason === RecoveryReasons.FRAME_STALLED
	)), false);
	camera.destroy();
});

for (const observer of ['onError', 'onRecovery']) {
	for (const action of ['stop', 'destroy']) {
		test(`${action} from ${observer} preserves the terminal recovery state`, async () => {
			const initialTrack = new FakeTrack();
			const mediaDevices = new FakeMediaDevices([
				new FakeStream([initialTrack]),
				namedError('NotReadableError', 'Camera unavailable'),
			]);
			let acted = false;
			let camera;
			const observerCallback = (event) => {
				if (acted || (observer === 'onRecovery' && event.phase !== 'failed')) {
					return;
				}
				acted = true;
				camera[action]();
			};
			camera = new ResilientWebcam({
				mediaDevices,
				maxRecoveryAttempts: 1,
				...automaticRecoveryOptions(),
				[observer]: observerCallback,
			});
			await camera.start();
			initialTrack.end();

			const terminalState = action === 'stop'
				? WebcamStates.STOPPED
				: WebcamStates.DESTROYED;
			await waitFor(() => camera.state === terminalState);
			await delay(10);
			assert.equal(camera.state, terminalState);
			assert.equal(mediaDevices.calls, 2);
			if (action === 'stop') {
				camera.destroy();
			}
		});
	}
}

test('manual start clears recovery deferred while hidden', async () => {
	const document = new FakeDocument();
	const initialTrack = new FakeTrack();
	const freshTrack = new FakeTrack();
	const unusedStream = new FakeStream();
	const freshStream = new FakeStream([freshTrack]);
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		freshStream,
		unusedStream,
	]);
	const camera = new ResilientWebcam({
		mediaDevices,
		document,
		...automaticRecoveryOptions(),
	});
	await camera.start();

	document.setHidden(true);
	initialTrack.end();
	assert.equal(camera.state, WebcamStates.RECOVERING);
	assert.strictEqual(await camera.start(), freshStream);
	assert.equal(camera.state, WebcamStates.READY);

	document.setHidden(false);
	await delay(20);
	assert.equal(mediaDevices.calls, 2);
	assert.equal(camera.stream, freshStream);
	assert.equal(freshTrack.stopCalls, 0);
	assert.equal(unusedStream.getTracks()[0].stopCalls, 0);
	camera.destroy();
});

test('stop from a scheduled observer leaves no recovery timer', async () => {
	const initialTrack = new FakeTrack();
	const mediaDevices = new FakeMediaDevices([new FakeStream([initialTrack])]);
	let camera;
	camera = new ResilientWebcam({
		mediaDevices,
		...automaticRecoveryOptions({
			recoveryInitialDelayMs: 50,
			recoveryMaxDelayMs: 50,
		}),
		onRecovery: (event) => {
			if (event.phase === 'scheduled') {
				camera.stop();
			}
		},
	});
	try {
		await camera.start();
		initialTrack.end();
		assert.equal(camera.state, WebcamStates.STOPPED);
		assert.equal(camera._recoveryTimer, null);
		assert.equal(mediaDevices.calls, 1);
	} finally {
		camera.destroy();
	}
});

test('restart from a scheduled observer cannot leave a second recovery timer', async () => {
	const initialTrack = new FakeTrack();
	const replacement = new FakeStream();
	const unexpectedStream = new FakeStream();
	const mediaDevices = new FakeMediaDevices([
		new FakeStream([initialTrack]),
		replacement,
		unexpectedStream,
	]);
	let reentrantRestart;
	let camera;
	camera = new ResilientWebcam({
		mediaDevices,
		...automaticRecoveryOptions({
			recoveryInitialDelayMs: 5,
			recoveryMaxDelayMs: 5,
		}),
		onRecovery: (event) => {
			if (event.phase === 'scheduled' && !reentrantRestart) {
				reentrantRestart = camera.restart();
			}
		},
	});
	try {
		await camera.start();
		initialTrack.end();
		assert.ok(reentrantRestart);
		assert.strictEqual(await reentrantRestart, replacement);
		await delay(20);
		assert.equal(mediaDevices.calls, 2);
		assert.equal(camera.stream, replacement);
		assert.equal(unexpectedStream.getTracks()[0].stopCalls, 0);
	} finally {
		camera.destroy();
	}
});
