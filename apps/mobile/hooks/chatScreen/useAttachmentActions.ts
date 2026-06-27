import { useCallback } from 'react'
import { Alert } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'

type AttachmentMode = 'camera' | 'photo' | 'file'

type SendAttachment = (opts: {
  uri: string
  mime: string
  name?: string
}) => Promise<void>

type Params = {
  sendAttachment: SendAttachment
  onAttachmentSent?: () => void
}

export function useAttachmentActions({ sendAttachment, onAttachmentSent }: Params) {
  const handleAttach = useCallback(async (mode: AttachmentMode) => {
    if (mode === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) {
        Alert.alert('Camera access required', 'Allow camera access in Settings to send photos.')
        return
      }
    } else if (mode === 'photo') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) {
        Alert.alert('Photo library access required', 'Allow photo library access in Settings to share images.')
        return
      }
    }

    if (mode === 'file') {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
      if (result.canceled) return
      const asset = result.assets[0]
      await sendAttachment({
        uri: asset.uri,
        mime: asset.mimeType ?? 'application/octet-stream',
        name: asset.name,
      })
      onAttachmentSent?.()
      return
    }

    const result = mode === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 })

    if (result.canceled) return

    const asset = result.assets[0]
    await sendAttachment({
      uri: asset.uri,
      mime: asset.mimeType ?? 'image/jpeg',
      name: asset.fileName ?? undefined,
    })
    onAttachmentSent?.()
  }, [onAttachmentSent, sendAttachment])

  const handleAttachCamera = useCallback(() => {
    handleAttach('camera').catch(console.warn)
  }, [handleAttach])

  const handleAttachPhoto = useCallback(() => {
    handleAttach('photo').catch(console.warn)
  }, [handleAttach])

  const handleAttachFile = useCallback(() => {
    handleAttach('file').catch(console.warn)
  }, [handleAttach])

  return {
    handleAttachCamera,
    handleAttachPhoto,
    handleAttachFile,
  }
}
