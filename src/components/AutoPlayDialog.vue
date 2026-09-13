<template>
  <v-dialog v-model="visible" max-width="860" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon>mdi-access-point-network</v-icon>
        <span>{{ t('lineConnect.title') }}</span>
        <v-spacer />
        <v-chip
          v-if="isRunning"
          color="success"
          size="small"
          variant="flat"
          class="mr-2"
        >
          {{ t('lineConnect.running') }}
        </v-chip>
        <v-chip v-else size="small" variant="tonal">
          {{ t('lineConnect.stopped') }}
        </v-chip>
      </v-card-title>

      <v-divider />

      <v-card-text class="lc-body">
        <v-alert
          v-if="!isSupported"
          type="warning"
          density="compact"
          variant="tonal"
          class="mb-3"
        >
          {{ t('lineConnect.androidOnly') }}
        </v-alert>

        <!-- Permission checklist -->
        <div class="lc-checks">
          <v-card
            variant="outlined"
            class="lc-check"
            :class="{ 'lc-check--ok': captureOk }"
          >
            <div class="lc-check__head">
              <v-icon size="18">
                {{ captureOk ? 'mdi-check-circle' : 'mdi-alert-circle-outline' }}
              </v-icon>
              <span>{{ t('lineConnect.screenCapture') }}</span>
            </div>
            <p class="lc-check__hint">
              {{
                captureRunning
                  ? t('lineConnect.captureRunningHint')
                  : captureOk
                    ? t('lineConnect.captureReadyHint')
                    : t('lineConnect.captureMissingHint')
              }}
            </p>
            <div class="lc-check__actions">
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                :disabled="!isSupported"
                @click="requestCapturePermission"
              >
                {{ t('lineConnect.requestPermission') }}
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                :disabled="!captureOk || captureRunning"
                @click="startCapture"
              >
                {{ t('lineConnect.startCapture') }}
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                :disabled="!captureRunning"
                @click="stopCapture"
              >
                {{ t('lineConnect.stopCapture') }}
              </v-btn>
            </div>
          </v-card>

          <v-card
            variant="outlined"
            class="lc-check"
            :class="{ 'lc-check--ok': a11yOk }"
          >
            <div class="lc-check__head">
              <v-icon size="18">
                {{ a11yOk ? 'mdi-check-circle' : 'mdi-alert-circle-outline' }}
              </v-icon>
              <span>{{ t('lineConnect.accessibility') }}</span>
            </div>
            <p class="lc-check__hint">
              {{
                a11yOk
                  ? t('lineConnect.accessibilityReadyHint')
                  : t('lineConnect.accessibilityMissingHint')
              }}
            </p>
            <div class="lc-check__actions">
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                :disabled="!isSupported"
                @click="openAccessibilitySettings"
              >
                {{ t('lineConnect.openAccessibility') }}
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                :disabled="!a11yOk"
                @click="testTap"
              >
                {{ t('lineConnect.testTap') }}
              </v-btn>
            </div>
          </v-card>

          <v-card
            variant="outlined"
            class="lc-check"
            :class="{ 'lc-check--ok': overlayOk }"
          >
            <div class="lc-check__head">
              <v-icon size="18">
                {{ overlayOk ? 'mdi-check-circle' : 'mdi-alert-circle-outline' }}
              </v-icon>
              <span>{{ t('lineConnect.overlay') }}</span>
            </div>
            <p class="lc-check__hint">
              {{
                overlayOk
                  ? t('lineConnect.overlayReadyHint')
                  : captureRunning
                    ? t('lineConnect.overlayNoPermissionHint')
                    : t('lineConnect.overlayNoServiceHint')
              }}
            </p>
            <div class="lc-check__actions">
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                :disabled="!isSupported || overlayOk"
                @click="grantOverlay"
              >
                {{ t('lineConnect.overlayGrant') }}
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                :disabled="!isSupported"
                @click="toggleOverlay"
              >
                {{
                  overlayVisible
                    ? t('lineConnect.overlayHide')
                    : t('lineConnect.overlayShow')
                }}
              </v-btn>
            </div>
          </v-card>

          <v-card
            variant="outlined"
            class="lc-check"
            :class="{ 'lc-check--ok': engineOk }"
          >
            <div class="lc-check__head">
              <v-icon size="18">
                {{ engineOk ? 'mdi-check-circle' : 'mdi-alert-circle-outline' }}
              </v-icon>
              <span>{{ t('lineConnect.engine') }}</span>
            </div>
            <p class="lc-check__hint">
              {{
                engineOk
                  ? t('lineConnect.engineReadyHint')
                  : t('lineConnect.engineMissingHint')
              }}
            </p>
          </v-card>
        </div>

        <v-alert
          v-if="overlayOk"
          type="info"
          density="compact"
          variant="tonal"
          class="mt-3"
        >
          {{ t('lineConnect.overlayTip') }}
        </v-alert>

        <!-- Configuration -->
        <v-expansion-panels variant="accordion" class="mt-3">
          <v-expansion-panel :title="t('lineConnect.settings')">
            <v-expansion-panel-text>
              <div class="lc-settings">
                <v-select
                  v-model="settings.mySide"
                  :items="sideOptions"
                  item-title="label"
                  item-value="value"
                  :label="t('lineConnect.mySide')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-select
                  v-model="settings.clickMode"
                  :items="clickModeOptions"
                  item-title="label"
                  item-value="value"
                  :label="t('lineConnect.clickMode')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.pollIntervalMs"
                  type="number"
                  :label="t('lineConnect.pollInterval')"
                  suffix="ms"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.thinkTimeMs"
                  type="number"
                  :label="t('lineConnect.thinkTime')"
                  suffix="ms"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.captureScale"
                  type="number"
                  step="0.05"
                  min="0.15"
                  max="1"
                  :label="t('lineConnect.captureScale')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.stableFrames"
                  type="number"
                  min="1"
                  max="6"
                  :label="t('lineConnect.stableFrames')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.clickGapMs"
                  type="number"
                  :label="t('lineConnect.clickGap')"
                  suffix="ms"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
                <v-text-field
                  v-model.number="settings.jpegQuality"
                  type="number"
                  min="30"
                  max="100"
                  :label="t('lineConnect.jpegQuality')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
              </div>
              <div class="lc-switches">
                <v-switch
                  v-model="settings.dryRun"
                  :label="t('lineConnect.dryRun')"
                  color="warning"
                  density="compact"
                  hide-details
                />
                <v-switch
                  v-model="settings.assumeMyTurn"
                  :label="t('lineConnect.assumeMyTurn')"
                  color="primary"
                  density="compact"
                  hide-details
                />
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel :title="t('lineConnect.diagnostics')">
            <v-expansion-panel-text>
              <div class="lc-stats">
                <span>{{ t('lineConnect.phase') }}: {{ phase }}</span>
                <span>{{ t('lineConnect.passes') }}: {{ passes }}</span>
                <span>{{ t('lineConnect.moves') }}: {{ moveCount }}</span>
                <span>{{ t('lineConnect.detections') }}: {{ detectionCount }}</span>
                <span>{{ t('lineConnect.errors') }}: {{ errorCount }}</span>
                <span>
                  {{ t('lineConnect.board') }}:
                  {{ boardDetected ? t('lineConnect.found') : t('lineConnect.missing') }}
                </span>
                <span>{{ t('lineConnect.overlayTicks') }}: {{ tickCount }}</span>
              </div>

              <div v-if="lastWarnings.length" class="lc-warnings">
                <v-icon size="14">mdi-alert</v-icon>
                {{ lastWarnings.join(' · ') }}
              </div>

              <div v-if="lastPreview" class="lc-preview">
                <img :src="lastPreview" alt="preview" />
              </div>

              <v-textarea
                :model-value="lastFen"
                :label="t('lineConnect.lastFen')"
                rows="2"
                density="compact"
                variant="outlined"
                readonly
                hide-details
                class="mt-2"
              />

              <div class="lc-log-head">
                <span>{{ t('lineConnect.logs') }}</span>
                <v-btn size="x-small" variant="text" @click="clearLogs">
                  {{ t('lineConnect.clear') }}
                </v-btn>
              </div>
              <div ref="logContainer" class="lc-logs">
                <div
                  v-for="(entry, index) in logs"
                  :key="index"
                  class="lc-log"
                  :class="`lc-log--${entry.level}`"
                >
                  <span class="lc-log__time">{{ formatTime(entry.time) }}</span>
                  <span class="lc-log__text">{{ entry.text }}</span>
                </div>
                <div v-if="!logs.length" class="lc-log lc-log--empty">
                  {{ t('lineConnect.noLogs') }}
                </div>
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>

      <v-divider />

      <v-card-actions>
        <v-btn
          size="small"
          variant="text"
          :disabled="!isSupported"
          @click="stepOnce"
        >
          {{ t('lineConnect.stepOnce') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="visible = false">
          {{ t('lineConnect.close') }}
        </v-btn>
        <v-btn
          v-if="!isRunning"
          color="primary"
          variant="flat"
          :disabled="!isSupported"
          @click="start"
        >
          {{ t('lineConnect.start') }}
        </v-btn>
        <v-btn v-else color="error" variant="flat" @click="stop">
          {{ t('lineConnect.stop') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
  import { ref, computed, inject, onMounted, onUnmounted, watch, nextTick } from 'vue'
  import { useI18n } from 'vue-i18n'
  import { useImageRecognition } from '../composables/image-recognition'
  import { useLineConnect } from '../composables/line-connect/useLineConnect'

  const props = defineProps<{ modelValue: boolean }>()
  const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

  const visible = computed({
    get: () => props.modelValue,
    set: value => emit('update:modelValue', value),
  })

  const { t } = useI18n()

  const game: any = inject('game-state')
  const engine: any = inject('engine-state')
  const recognition = useImageRecognition()

  const lc = useLineConnect({ recognition, game, engine })

  const {
    settings,
    isRunning,
    phase,
    logs,
    lastPreview,
    lastFen,
    passes,
    moveCount,
    errorCount,
    detectionCount,
    boardDetected,
    lastWarnings,
    isSupported,
    isCapturing,
    hasCapturePermission,
    hasAccessibility,
    overlayVisible,
    tickCount,
    showOverlay,
    hideOverlay,
    refreshOverlayVisible,
    canDrawOverlays,
    requestCapturePermission,
    openAccessibilitySettings,
    startCapture,
    stopCapture,
    testTap,
    start,
    stop,
    stepOnce,
    clearLogs,
  } = lc

  const captureOk = ref(false)
  const captureRunning = ref(false)
  const a11yOk = ref(false)
  const overlayOk = ref(false)
  const engineOk = computed(() => !!engine?.isEngineLoaded?.value)

  const logContainer = ref<HTMLElement | null>(null)

  const sideOptions = computed(() => [
    { label: t('lineConnect.red'), value: 'w' },
    { label: t('lineConnect.black'), value: 'b' },
  ])

  const clickModeOptions = computed(() => [
    { label: t('lineConnect.tapMode'), value: 'tap' },
    { label: t('lineConnect.dragMode'), value: 'drag' },
  ])

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function refreshStatus() {
    captureOk.value = hasCapturePermission() || isCapturing()
    captureRunning.value = isCapturing()
    a11yOk.value = hasAccessibility()
    overlayOk.value = isSupported() && canDrawOverlays()
    refreshOverlayVisible()
  }

  function grantOverlay() {
    lc.openOverlaySettings()
  }

  function toggleOverlay() {
    if (overlayVisible.value) {
      hideOverlay()
    } else {
      showOverlay()
    }
    refreshStatus()
  }

  function formatTime(ts: number): string {
    const date = new Date(ts)
    return `${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes()
    ).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  }

  watch(visible, value => {
    if (value) {
      refreshStatus()
    }
  })

  // The overlay permission is granted in system settings, so re-check on focus.
  function onWindowFocus() {
    refreshStatus()
  }

  watch(
    () => logs.value.length,
    async () => {
      await nextTick()
      const el = logContainer.value
      if (el) el.scrollTop = el.scrollHeight
    }
  )

  // Remote updates (permission dialog result, capture service state) arrive via
  // a window event dispatched from the Android layer.
  function onProjectionEvent() {
    refreshStatus()
  }

  onMounted(() => {
    refreshStatus()
    pollTimer = setInterval(refreshStatus, 1500)
    window.addEventListener('line-connect-projection', onProjectionEvent)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onWindowFocus)
  })

  onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer)
    window.removeEventListener('line-connect-projection', onProjectionEvent)
    window.removeEventListener('focus', onWindowFocus)
    document.removeEventListener('visibilitychange', onWindowFocus)
    // The line-connect session deliberately keeps running when the dialog is
    // closed: the floating bar is the control surface from then on.
  })
</script>

<style lang="scss" scoped>
  .lc-body {
    display: block;
  }

  .lc-checks {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
  }

  .lc-check {
    padding: 10px 12px;
    border-radius: 8px;

    .lc-check__head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 14px;
    }

    .lc-check__hint {
      margin: 6px 0 8px;
      font-size: 12px;
      opacity: 0.75;
      line-height: 1.4;
    }

    .lc-check__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    &--ok {
      border-color: rgb(var(--v-theme-success));
      .lc-check__head {
        color: rgb(var(--v-theme-success));
      }
    }
  }

  .lc-settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-bottom: 8px;
  }

  .lc-switches {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
  }

  .lc-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    opacity: 0.85;
    margin-bottom: 6px;
  }

  .lc-warnings {
    font-size: 12px;
    color: rgb(var(--v-theme-warning));
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .lc-preview {
    max-height: 220px;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid rgba(var(--v-border-color), 0.4);
    margin-bottom: 6px;

    img {
      width: 100%;
      display: block;
    }
  }

  .lc-log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 600;
    margin: 10px 0 4px;
  }

  .lc-logs {
    max-height: 180px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid rgba(var(--v-border-color), 0.4);
    border-radius: 6px;
    padding: 6px 8px;
  }

  .lc-log {
    display: flex;
    gap: 8px;

    &__time {
      opacity: 0.55;
      flex: 0 0 auto;
    }

    &--warn .lc-log__text {
      color: rgb(var(--v-theme-warning));
    }

    &--error .lc-log__text {
      color: rgb(var(--v-theme-error));
    }

    &--move .lc-log__text {
      color: rgb(var(--v-theme-success));
      font-weight: 600;
    }

    &--empty {
      opacity: 0.5;
    }
  }
</style>
