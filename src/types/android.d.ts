// Android JavaScript interface types
declare global {
  interface Window {
    ExternalUrlInterface?: {
      openExternalUrl(url: string): void
    }
    SafFileInterface?: {
      startFileSelection(): void
    }
    /**
     * Bridge injected by MainActivity for the line-connect (连线自动走棋)
     * feature. Only present on Android.
     */
    LineConnect?: LineConnectBridge
  }
}

export interface LineConnectCaptureStatus {
  running: boolean
  screenWidth: number
  screenHeight: number
  frameWidth: number
  frameHeight: number
  lastFrameTime: number
  frames: number
  hasPermission: boolean
}

export interface LineConnectBridge {
  hasCapturePermission(): boolean
  requestCapturePermission(): void
  clearCapturePermission(): void
  startCapture(scale: number, quality: number, intervalMs: number): boolean
  stopCapture(): void
  isCapturing(): boolean
  /** Newest frame as base64 JPEG, or an empty string when unavailable. */
  captureFrame(): string
  /** JSON payload, see LineConnectCaptureStatus. */
  captureStatus(): string
  hasAccessibility(): boolean
  openAccessibilitySettings(): void
  /* Floating control bar (shown while other apps are in the foreground) */
  canDrawOverlays(): boolean
  showOverlay(): boolean
  hideOverlay(): void
  isOverlayVisible(): boolean
  /** JSON payload with any of: turn, status, evaluation, waiting, autoRunning, autoEnabled, scanEnabled */
  updateOverlay(json: string): boolean
  /** Native loop driver: keeps the polling loop alive while the webview is hidden. */
  startTick(intervalMs: number): boolean
  stopTick(): void
  /** Brings the app back to the foreground. */
  bringToFront(): void
  /** Opens the "display over other apps" system settings page. */
  openOverlaySettings(): void
  /**
   * Cropped capture of the newest frame. Coordinates are captured-frame pixels;
   * much cheaper than transferring a whole screenshot once the board is located.
   */
  captureCrop(
    left: number,
    top: number,
    width: number,
    height: number,
    maxEdge: number
  ): string
  /** Fraction (0..1) of the frame that changed since the previous frame. */
  frameChangeRatio(): number

  /* Floating chessboard (movable + resizable) */
  showChessboard(): boolean
  hideChessboard(): void
  isChessboardVisible(): boolean
  /** Pushes the recognised Jieqi FEN into the floating chessboard. */
  setChessboardFen(fen: string): void

  /* Dataset collection for fine-tuning */
  startSampleRecording(): boolean
  stopSampleRecording(): void
  isSampleRecording(): boolean
  sampleCount(): number
  samplePath(): string
  /** Saves the newest frame plus the recognition result as a sample pair. */
  saveSample(annotationJson: string): boolean
  requestStoragePermission(): void
  tap(x: number, y: number, durationMs: number): boolean
  swipe(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number
  ): boolean
  lastGestureError(): string
  currentForegroundPackage(): string
  openOverlaySettings(): void
}

export {}
