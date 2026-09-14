/**
 * Shared types for the line-connect (连线自动走棋) feature.
 */

/** Colour of the side to move in a Jieqi FEN. */
export type SideToMove = 'w' | 'b'

/** How the auto player should perform a move on the mirrored board. */
export type ClickMode = 'tap' | 'drag'

export interface LineConnectSettings {
  /** Side the user is playing on the mirrored platform. */
  mySide: SideToMove
  /** Delay between two recognition passes, in milliseconds. */
  pollIntervalMs: number
  /**
   * Resolution factor applied to the screen before recognition (0.15 - 1).
   * Keep this high enough that the board still spans a few hundred pixels —
   * the detector needs roughly 25px per piece to be reliable.
   */
  captureScale: number
  /** JPEG quality used when transferring a frame to the webview. */
  jpegQuality: number
  /** How many identical frames in a row are required before acting. */
  stableFrames: number
  /** Engine thinking time per move, in milliseconds. */
  thinkTimeMs: number
  /** Whether a move is played with two taps or with a drag. */
  clickMode: ClickMode
  /** Pause between the "pick up" and "put down" gesture. */
  clickGapMs: number
  /** Mirror the recognised position onto the app board. */
  syncBoard: boolean
  /** Practice mode: analyse and log, but never touch the screen. */
  dryRun: boolean
  /** Assume it is the user's turn when the loop starts. */
  assumeMyTurn: boolean
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
  /** Save screenshots plus recognition results for labelling / fine-tuning. */
  recordSamples: boolean
}

export const DEFAULT_SETTINGS: LineConnectSettings = {
  mySide: 'w',
  pollIntervalMs: 500,
  captureScale: 0.75,
  jpegQuality: 70,
  stableFrames: 2,
  thinkTimeMs: 1200,
  clickMode: 'tap',
  clickGapMs: 120,
  syncBoard: true,
  dryRun: false,
  assumeMyTurn: true,
  minScore: 0.35,
  useBoardCrop: true,
  cropMaxEdge: 640,
  relocateEvery: 25,
  skipUnchangedFrames: true,
  changeThreshold: 0.002,
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
