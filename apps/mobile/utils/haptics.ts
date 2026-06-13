/**
 * Thin, crash-safe wrappers over expo-haptics. The native call throws/rejects on
 * web and on dev clients built before expo-haptics was linked, so every call is
 * guarded — feedback is a nicety, never load-bearing.
 */
import * as Haptics from 'expo-haptics'

/** Light selection tick — toggles, menu picks, swipe-action commits. */
export function selectionHaptic(): void {
  try {
    Haptics.selectionAsync().catch(() => {})
  } catch {
    /* haptics unavailable — ignore */
  }
}

/** Light impact — committing an action such as sending a message. */
export function impactHaptic(): void {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  } catch {
    /* haptics unavailable — ignore */
  }
}
