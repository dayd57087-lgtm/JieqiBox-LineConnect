/**
 * Shared types for the line-connect (连线自动走棋) feature.
 */

/** Colour of the side to move in a Jieqi FEN. */
export type SideToMove = 'w' | 'b'

/** How the auto player should perform a move on the mirrored board. */
export type ClickMode = 'tap' | 'drag'

/** Which side the user plays. `auto` infers it from the observed game flow. */
export type SideSetting = 'auto' | 'w' | 'b'

export interface LineConnectSettings {
  /**
   * Side the user is playing.
   *
   * `auto` (the default) works it out from the game flow: the standard opening
   * position tells us red is to move, and any move that happens while we are not
   * playing must have been made by the opponent.
   */
  mySide: SideSetting
  /** How long to wait for the opponent before assuming it is our turn, in ms. */
  detectWindowMs: number
  /** Delay between two recognition passes, in milliseconds. */
  pollIntervalMs: number
  /** Resolution factor applied to the screen before recognition (0.15 - 1). */
  captureScale: number
  /** JPEG quality used when transferring a frame to the webview. */
  jpegQuality: number
  /** How many identical observations are required before acting. */
  stableFrames: number
  /** Engine thinking time per move, in milliseconds. */
  thinkTimeMs: number
  /** Whether a move is played with two taps or with a drag. */
  clickMode: ClickMode
  /** Pause between the "pick up" and "put down" gesture. */
  clickGapMs: number
  /** Mirror the recognised position onto the app board. */
  syncBoard: boolean
  /** Minimum confidence for a detection to be trusted. */
  minScore: number
  /**
   * Analyse only the board crop once it has been located.
   *
   * This is the main accuracy and speed win: the payload sent over the JS
   * bridge shrinks by roughly an order of magnitude and the pieces become much
   * larger relative to the model input.
   */
  useBoardCrop: boolean
  /** Longest edge of the crop handed to the model. */
  cropMaxEdge: number
  /** Re-run a full-frame pass every N passes to re-locate the board. */
  relocateEvery: number
  /** Skip inference entirely while the screen is not changing. */
  skipUnchangedFrames: boolean
  /** Fraction of changed frame cells that counts as "something happened". */
  changeThreshold: number
  /**
   * Model input size. Only used when the loaded model accepts dynamic shapes;
   * a fixed-shape model keeps its own size.
   */
  modelInputSize: number
  /** Save screenshots plus recognition results for labelling / fine-tuning. */
  recordSamples: boolean
}

export const DEFAULT_SETTINGS: LineConnectSettings = {
  mySide: 'auto',
  detectWindowMs: 3500,
  pollIntervalMs: 400,
  captureScale: 0.75,
  jpegQuality: 70,
  stableFrames: 2,
  thinkTimeMs: 800,
  clickMode: 'tap',
  clickGapMs: 120,
  syncBoard: true,
  minScore: 0.35,
  useBoardCrop: true,
  cropMaxEdge: 512,
  relocateEvery: 30,
  skipUnchangedFrames: true,
  changeThreshold: 0.004,
  modelInputSize: 416,
  recordSamples: false,
}

export type LogLevel = 'info' | 'warn' | 'error' | 'move'

export interface LogEntry {
  time: number
  level: LogLevel
  text: string
}

export interface CaptureStatus {
  running: boolean
  screenWidth: number
  screenHeight: number
  frameWidth: number
  frameHeight: number
  lastFrameTime: number
  frames: number
  hasPermission: boolean
}

/** Payload pushed into the floating chessboard so it can draw arrows. */
export interface BoardMoveHint {
  /** Engine's suggested move, UCI. */
  best?: string
  /** The move that produced the current position, UCI. */
  last?: string
}
