import { extensionForMime, filePreviewLabel, isAudioMime } from './fileHelpers'

describe('isAudioMime', () => {
  test('is true for audio/* types', () => {
    expect(isAudioMime('audio/mpeg')).toBe(true)
    expect(isAudioMime('audio/ogg')).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isAudioMime('Audio/WAV')).toBe(true)
  })

  test('is false for non-audio types', () => {
    expect(isAudioMime('image/png')).toBe(false)
    expect(isAudioMime('application/pdf')).toBe(false)
    expect(isAudioMime('')).toBe(false)
  })
})

describe('extensionForMime', () => {
  test('maps known audio mimes to extensions', () => {
    expect(extensionForMime('audio/mpeg')).toBe('mp3')
    expect(extensionForMime('audio/ogg')).toBe('ogg')
    expect(extensionForMime('audio/wav')).toBe('wav')
    expect(extensionForMime('audio/aac')).toBe('m4a')
  })

  test('is case-insensitive on the mime', () => {
    expect(extensionForMime('AUDIO/MPEG')).toBe('mp3')
  })

  test('falls back to the filename extension for unknown mimes', () => {
    expect(extensionForMime('application/octet-stream', 'voice.ogg')).toBe('ogg')
    expect(extensionForMime('application/octet-stream', 'Note.M4A')).toBe('m4a')
  })

  test('falls back to bin when nothing else is known', () => {
    expect(extensionForMime('application/octet-stream')).toBe('bin')
    expect(extensionForMime('application/octet-stream', 'noextension')).toBe('bin')
  })
})

describe('filePreviewLabel', () => {
  test('uses a speaker + name for audio', () => {
    expect(filePreviewLabel({ mime: 'audio/mpeg', name: 'clip.mp3' })).toBe('🔊 clip.mp3')
  })

  test('falls back to a generic audio label when unnamed', () => {
    expect(filePreviewLabel({ mime: 'audio/ogg' })).toBe('🔊 Audio message')
  })

  test('uses a paperclip for non-audio files', () => {
    expect(filePreviewLabel({ mime: 'image/png', name: 'photo.png' })).toBe('📎 photo.png')
    expect(filePreviewLabel({ mime: 'image/png' })).toBe('📎 image/png')
  })
})
