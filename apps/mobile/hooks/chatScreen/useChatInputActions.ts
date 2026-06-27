import { useCallback, useState } from 'react'

type Params = {
  trimmedDraft: string
  setDraft: (value: string) => void
  sendMessage: (text: string) => void
  sendAudio: (uri: string, durationMs: number) => Promise<void>
  onScrollToBottom: () => void
}

export function useChatInputActions({ trimmedDraft, setDraft, sendMessage, sendAudio, onScrollToBottom }: Params) {
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [activeModel, setActiveModel] = useState<string | undefined>()

  const handleSend = useCallback(() => {
    const text = trimmedDraft
    if (!text) return

    // Intercept /model with no args and open picker locally.
    if (text === '/model') {
      setShowModelPicker(true)
      setDraft('')
      return
    }

    sendMessage(text)
    setDraft('')
    onScrollToBottom()
  }, [onScrollToBottom, sendMessage, trimmedDraft])

  const handleSendAudio = useCallback((uri: string, durationMs: number) => {
    sendAudio(uri, durationMs).catch(console.warn)
    onScrollToBottom()
  }, [onScrollToBottom, sendAudio])

  const handleCommandSelect = useCallback((name: string) => {
    if (name === 'model') {
      setShowModelPicker(true)
      setDraft('')
      return
    }
    setDraft(`/${name} `)
  }, [])

  const handleModelSelect = useCallback((modelId: string) => {
    setActiveModel(modelId)
    sendMessage(`/model ${modelId}`)
    onScrollToBottom()
  }, [onScrollToBottom, sendMessage])

  return {
    showModelPicker,
    setShowModelPicker,
    activeModel,
    handleSend,
    handleSendAudio,
    handleCommandSelect,
    handleModelSelect,
  }
}
