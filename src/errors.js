export const ErrorCodes = Object.freeze({
	NOT_SUPPORTED: 'NOT_SUPPORTED',
	INVALID_ARGUMENT: 'INVALID_ARGUMENT',
	PERMISSION_DENIED: 'PERMISSION_DENIED',
	DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
	DEVICE_BUSY: 'DEVICE_BUSY',
	CONSTRAINT_UNSATISFIED: 'CONSTRAINT_UNSATISFIED',
	REQUEST_ABORTED: 'REQUEST_ABORTED',
	REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
	NO_VIDEO_TRACK: 'NO_VIDEO_TRACK',
	OPERATION_CANCELLED: 'OPERATION_CANCELLED',
	VIDEO_NOT_READY: 'VIDEO_NOT_READY',
	VIDEO_PLAY_FAILED: 'VIDEO_PLAY_FAILED',
	CAPTURE_FAILED: 'CAPTURE_FAILED',
	RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED',
	DESTROYED: 'DESTROYED',
	UNKNOWN: 'UNKNOWN',
});

const MEDIA_ERROR_CODES = Object.freeze({
	NotAllowedError: ErrorCodes.PERMISSION_DENIED,
	SecurityError: ErrorCodes.PERMISSION_DENIED,
	NotFoundError: ErrorCodes.DEVICE_NOT_FOUND,
	DevicesNotFoundError: ErrorCodes.DEVICE_NOT_FOUND,
	NotReadableError: ErrorCodes.DEVICE_BUSY,
	TrackStartError: ErrorCodes.DEVICE_BUSY,
	OverconstrainedError: ErrorCodes.CONSTRAINT_UNSATISFIED,
	ConstraintNotSatisfiedError: ErrorCodes.CONSTRAINT_UNSATISFIED,
	AbortError: ErrorCodes.REQUEST_ABORTED,
});

const NON_RECOVERABLE_CODES = new Set([
	ErrorCodes.INVALID_ARGUMENT,
	ErrorCodes.PERMISSION_DENIED,
	ErrorCodes.CONSTRAINT_UNSATISFIED,
	ErrorCodes.NOT_SUPPORTED,
	ErrorCodes.DESTROYED,
]);

export class ResilientWebcamError extends Error {
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ResilientWebcamError';
		this.code = code;
		this.recoverable = options.recoverable ?? !NON_RECOVERABLE_CODES.has(code);
		this.details = options.details ?? null;
	}
}

export function normalizeMediaError(error, fallbackMessage = 'Unable to access the camera') {
	if (error instanceof ResilientWebcamError) {
		return error;
	}

	const name = typeof error?.name === 'string' ? error.name : '';
	const code = MEDIA_ERROR_CODES[name] ?? ErrorCodes.UNKNOWN;
	const message = typeof error?.message === 'string' && error.message
		? error.message
		: fallbackMessage;
	const details = name === 'OverconstrainedError' && error.constraint
		? { constraint: error.constraint }
		: null;

	return new ResilientWebcamError(code, message, {
		cause: error,
		details,
	});
}

export function operationCancelledError() {
	return new ResilientWebcamError(
		ErrorCodes.OPERATION_CANCELLED,
		'The camera operation was superseded or stopped',
		{ recoverable: true },
	);
}
