export type WebcamState =
	| 'idle'
	| 'starting'
	| 'ready'
	| 'recovering'
	| 'stopped'
	| 'failed'
	| 'destroyed';

export type RecoveryReason =
	| 'manual'
	| 'track-ended'
	| 'track-muted'
	| 'device-change'
	| 'frame-stalled'
	| 'black-frame'
	| 'video-play-failed';

export type ErrorCode =
	| 'NOT_SUPPORTED'
	| 'INVALID_ARGUMENT'
	| 'PERMISSION_DENIED'
	| 'DEVICE_NOT_FOUND'
	| 'DEVICE_BUSY'
	| 'CONSTRAINT_UNSATISFIED'
	| 'REQUEST_ABORTED'
	| 'REQUEST_TIMEOUT'
	| 'NO_VIDEO_TRACK'
	| 'OPERATION_CANCELLED'
	| 'VIDEO_NOT_READY'
	| 'VIDEO_PLAY_FAILED'
	| 'CAPTURE_FAILED'
	| 'RECOVERY_EXHAUSTED'
	| 'DESTROYED'
	| 'UNKNOWN';

export interface BlackFrameOptions {
	luminanceThreshold?: number;
	darkPixelRatio?: number;
	sampleStride?: number;
}

export interface BlackFrameAnalysis {
	readonly nearBlack: boolean;
	readonly darkPixelRatio: number;
	readonly meanLuminance: number;
	readonly sampledPixels: number;
}

export interface CaptureOptions {
	type?: string;
	quality?: number;
	width?: number;
	height?: number;
	readyTimeoutMs?: number;
	encodeTimeoutMs?: number;
	blackFrameDetection?: boolean | BlackFrameOptions;
	restartAndRetryOnBlack?: boolean;
}

export interface CaptureResult {
	readonly blob: Blob;
	readonly width: number;
	readonly height: number;
	readonly type: string;
	readonly nearBlack: boolean;
	readonly analysis: BlackFrameAnalysis | null;
	readonly retried: boolean;
	readonly capturedAt: number;
}

export interface WebcamStatus {
	readonly state: WebcamState;
	readonly desiredRunning: boolean;
	readonly attached: boolean;
	readonly hasStream: boolean;
	readonly deviceId: string | null;
	readonly recoveryAttempt: number;
	readonly maxRecoveryAttempts: number;
	readonly lastRecoveryReason: string | null;
	readonly lastFrameAt: number | null;
	readonly lastError: ResilientWebcamError | null;
}

export interface BaseWebcamEvent {
	readonly type: 'status' | 'stream' | 'recovery' | 'error' | 'capture';
	readonly timestamp: number;
	readonly status: WebcamStatus;
}

export interface StatusEvent extends BaseWebcamEvent {
	readonly type: 'status';
	readonly state: WebcamState;
	readonly previousState: WebcamState;
	readonly reason: string;
}

export interface StreamEvent extends BaseWebcamEvent {
	readonly type: 'stream';
	readonly action: 'started' | 'stopped';
	readonly reason?: string;
}

export type RecoveryPhase =
	| 'deferred'
	| 'coalesced'
	| 'cancelled'
	| 'scheduled'
	| 'attempting'
	| 'succeeded'
	| 'failed'
	| 'exhausted'
	| 'reset';

export interface RecoveryEvent extends BaseWebcamEvent {
	readonly type: 'recovery';
	readonly phase: RecoveryPhase;
	readonly reason: string;
	readonly attempt?: number;
	readonly maxAttempts?: number;
	readonly delayMs?: number;
	readonly details?: Readonly<Record<string, unknown>> | null;
	readonly error?: ResilientWebcamError;
}

export interface ErrorEvent extends BaseWebcamEvent {
	readonly type: 'error';
	readonly error: ResilientWebcamError;
}

export interface CaptureEvent extends BaseWebcamEvent {
	readonly type: 'capture';
	readonly phase: 'black-frame-detected' | 'completed';
	readonly width?: number;
	readonly height?: number;
	readonly captureType?: string;
	readonly nearBlack?: boolean;
	readonly retried?: boolean;
	readonly analysis?: BlackFrameAnalysis;
}

export type WebcamEvent =
	| StatusEvent
	| StreamEvent
	| RecoveryEvent
	| ErrorEvent
	| CaptureEvent;

export type WebcamEventListener = (event: WebcamEvent) => void;

export interface ResilientWebcamOptions {
	videoConstraints?: true | MediaTrackConstraints;
	requestTimeoutMs?: number;
	playTimeoutMs?: number;
	muteGraceMs?: number;
	frameTimeoutMs?: number;
	pauseWhenHidden?: boolean;
	restartOnDeviceChange?: boolean;
	deviceChangeDebounceMs?: number;
	maxRecoveryAttempts?: number;
	recoveryInitialDelayMs?: number;
	recoveryMaxDelayMs?: number;
	recoveryBackoffFactor?: number;
	recoveryJitter?: number;
	recoveryResetAfterMs?: number;
	capture?: CaptureOptions;
	onEvent?: WebcamEventListener;
	onStatus?: (event: StatusEvent) => void;
	onRecovery?: (event: RecoveryEvent) => void;
	onError?: (event: ErrorEvent) => void;
	mediaDevices?: MediaDevices;
	document?: Document;
	now?: () => number;
	random?: () => number;
	canvasFactory?: (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;
}

export class ResilientWebcamError extends Error {
	readonly code: ErrorCode;
	readonly recoverable: boolean;
	readonly details: Readonly<Record<string, unknown>> | null;
	readonly cause?: unknown;
	constructor(
		code: ErrorCode,
		message: string,
		options?: {
			cause?: unknown;
			recoverable?: boolean;
			details?: Readonly<Record<string, unknown>> | null;
		},
	);
}

export class ResilientWebcam {
	constructor(options?: ResilientWebcamOptions);
	get state(): WebcamState;
	get stream(): MediaStream | null;
	get video(): HTMLVideoElement | null;
	get status(): WebcamStatus;
	attach(video: HTMLVideoElement): this;
	detach(): this;
	start(): Promise<MediaStream>;
	stop(): void;
	restart(reason?: RecoveryReason | string): Promise<MediaStream>;
	capture(options?: CaptureOptions): Promise<CaptureResult>;
	subscribe(listener: WebcamEventListener): () => void;
	destroy(): void;
}

export function createResilientWebcam(options?: ResilientWebcamOptions): ResilientWebcam;

export function normalizeMediaError(
	error: unknown,
	fallbackMessage?: string,
): ResilientWebcamError;

export const WebcamStates: Readonly<{
	IDLE: 'idle';
	STARTING: 'starting';
	READY: 'ready';
	RECOVERING: 'recovering';
	STOPPED: 'stopped';
	FAILED: 'failed';
	DESTROYED: 'destroyed';
}>;

export const RecoveryReasons: Readonly<{
	MANUAL: 'manual';
	TRACK_ENDED: 'track-ended';
	TRACK_MUTED: 'track-muted';
	DEVICE_CHANGE: 'device-change';
	FRAME_STALLED: 'frame-stalled';
	BLACK_FRAME: 'black-frame';
	VIDEO_PLAY_FAILED: 'video-play-failed';
}>;

export const ErrorCodes: Readonly<Record<
	| 'NOT_SUPPORTED'
	| 'INVALID_ARGUMENT'
	| 'PERMISSION_DENIED'
	| 'DEVICE_NOT_FOUND'
	| 'DEVICE_BUSY'
	| 'CONSTRAINT_UNSATISFIED'
	| 'REQUEST_ABORTED'
	| 'REQUEST_TIMEOUT'
	| 'NO_VIDEO_TRACK'
	| 'OPERATION_CANCELLED'
	| 'VIDEO_NOT_READY'
	| 'VIDEO_PLAY_FAILED'
	| 'CAPTURE_FAILED'
	| 'RECOVERY_EXHAUSTED'
	| 'DESTROYED'
	| 'UNKNOWN',
	ErrorCode
>>;

export const DEFAULT_BLACK_FRAME_OPTIONS: Readonly<Required<BlackFrameOptions>>;

export function analyzeFramePixels(
	pixelData: ArrayLike<number>,
	options?: BlackFrameOptions,
): BlackFrameAnalysis;

export function isNearBlackFrame(
	pixelData: ArrayLike<number>,
	options?: BlackFrameOptions,
): boolean;

export function resolveCaptureSize(
	videoWidth: number,
	videoHeight: number,
	requestedWidth?: number,
	requestedHeight?: number,
): Readonly<{ width: number; height: number }>;
