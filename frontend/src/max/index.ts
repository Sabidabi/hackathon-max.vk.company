// Public entry of the MAX layer. Features import from here, never from `window.WebApp`.
export { getMaxBridge, readMaxContext, type MaxContext, type MaxPlatform } from "./bridge";
export {
  boostBrightness,
  canScanQr,
  closingConfirmation,
  deviceStorage,
  downloadFile,
  haptics,
  openLink,
  openMaxLink,
  ready,
  restoreBrightness,
  scanQr,
  share,
  type ShareResult,
} from "./platform";
export { parseStartParam, scannedTargetPath, startTargetPath, START_PARAM_MAX_LENGTH, type StartTarget } from "./startParam";
export { pushBackHandler, useBackButton } from "./useBackButton";
