import type { Feather } from '@expo/vector-icons'
import type { ComponentProps } from 'react'

export type ComposerProps = {
  draft: string
  setDraft: (text: string) => void
  onSend: () => void
  canSend: boolean
  blocked?: boolean
  onSendAudio?: (uri: string, durationMs: number) => void
  onAttachCamera?: () => void
  onAttachPhoto?: () => void
  onAttachFile?: () => void
}

export type ComposerMode = 'text' | 'voice-recording' | 'voice-review'

export interface AttachItem {
  icon: ComponentProps<typeof Feather>['name']
  label: string
  onPress: (() => void) | undefined
}
