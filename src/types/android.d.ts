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
