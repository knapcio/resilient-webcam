import { ErrorCodes, ResilientWebcamError } from './errors.js';

export const DEFAULT_BLACK_FRAME_OPTIONS = Object.freeze({
	luminanceThreshold: 16,
	darkPixelRatio: 0.985,
	sampleStride: 8,
});

function normalizeBlackFrameOptions(options = {}) {
	const luminanceThreshold = options.luminanceThreshold
		?? DEFAULT_BLACK_FRAME_OPTIONS.luminanceThreshold;
	const darkPixelRatio = options.darkPixelRatio
		?? DEFAULT_BLACK_FRAME_OPTIONS.darkPixelRatio;
	const sampleStride = options.sampleStride
		?? DEFAULT_BLACK_FRAME_OPTIONS.sampleStride;

	if (!Number.isFinite(luminanceThreshold) || luminanceThreshold < 0 || luminanceThreshold > 255) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'luminanceThreshold must be between 0 and 255',
		);
	}
	if (!Number.isFinite(darkPixelRatio) || darkPixelRatio < 0 || darkPixelRatio > 1) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'darkPixelRatio must be between 0 and 1',
		);
	}
	if (!Number.isInteger(sampleStride) || sampleStride < 1) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'sampleStride must be a positive integer',
		);
	}

	return { luminanceThreshold, darkPixelRatio, sampleStride };
}

export function analyzeFramePixels(pixelData, options = {}) {
	if (!pixelData || typeof pixelData.length !== 'number' || pixelData.length < 4) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'pixelData must contain RGBA pixel values',
		);
	}

	const config = normalizeBlackFrameOptions(options);
	let darkPixels = 0;
	let totalLuminance = 0;
	let sampledPixels = 0;
	const step = config.sampleStride * 4;

	for (let index = 0; index + 2 < pixelData.length; index += step) {
		const luminance = (
			(0.2126 * pixelData[index])
			+ (0.7152 * pixelData[index + 1])
			+ (0.0722 * pixelData[index + 2])
		);
		totalLuminance += luminance;
		darkPixels += luminance <= config.luminanceThreshold ? 1 : 0;
		sampledPixels += 1;
	}

	const darkPixelRatio = sampledPixels === 0 ? 0 : darkPixels / sampledPixels;
	const meanLuminance = sampledPixels === 0 ? 0 : totalLuminance / sampledPixels;

	return Object.freeze({
		nearBlack: darkPixelRatio >= config.darkPixelRatio,
		darkPixelRatio,
		meanLuminance,
		sampledPixels,
	});
}

export function isNearBlackFrame(pixelData, options = {}) {
	return analyzeFramePixels(pixelData, options).nearBlack;
}

export function resolveCaptureSize(videoWidth, videoHeight, requestedWidth, requestedHeight) {
	if (!(videoWidth > 0) || !(videoHeight > 0)) {
		throw new ResilientWebcamError(
			ErrorCodes.VIDEO_NOT_READY,
			'The video does not have a usable frame yet',
		);
	}

	if (requestedWidth !== undefined && (!(requestedWidth > 0) || !Number.isFinite(requestedWidth))) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'capture width must be a positive number',
		);
	}
	if (requestedHeight !== undefined && (!(requestedHeight > 0) || !Number.isFinite(requestedHeight))) {
		throw new ResilientWebcamError(
			ErrorCodes.INVALID_ARGUMENT,
			'capture height must be a positive number',
		);
	}

	let width = requestedWidth;
	let height = requestedHeight;
	if (width === undefined && height === undefined) {
		width = videoWidth;
		height = videoHeight;
	} else if (width === undefined) {
		width = height * (videoWidth / videoHeight);
	} else if (height === undefined) {
		height = width * (videoHeight / videoWidth);
	}

	return Object.freeze({
		width: Math.max(1, Math.round(width)),
		height: Math.max(1, Math.round(height)),
	});
}
