import {
  extensionForMime,
  filePreviewLabel,
  isAudioMime,
  isImageMime,
  isPdfMime,
  isHtmlMime,
  isMarkdownMime,
  isTextMime,
  fileViewerKind,
  fileIconName,
  approxBytesFromBase64,
  formatBytes,
} from './fileHelpers'

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

describe('mime classifiers', () => {
  test('isImageMime', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('IMAGE/JPEG')).toBe(true)
    expect(isImageMime('text/plain')).toBe(false)
  })

  test('isPdfMime', () => {
    expect(isPdfMime('application/pdf')).toBe(true)
    expect(isPdfMime('text/plain')).toBe(false)
  })

  test('isHtmlMime', () => {
    expect(isHtmlMime('text/html')).toBe(true)
    expect(isHtmlMime('application/xhtml+xml')).toBe(true)
    expect(isHtmlMime('text/plain')).toBe(false)
  })

  test('isMarkdownMime by mime or filename', () => {
    expect(isMarkdownMime('text/markdown')).toBe(true)
    expect(isMarkdownMime('text/x-markdown')).toBe(true)
    expect(isMarkdownMime('text/plain', 'README.md')).toBe(true)
    expect(isMarkdownMime('text/plain', 'notes.markdown')).toBe(true)
    expect(isMarkdownMime('text/plain', 'notes.txt')).toBe(false)
    expect(isMarkdownMime('text/plain')).toBe(false)
  })

  test('isTextMime', () => {
    expect(isTextMime('text/plain')).toBe(true)
    expect(isTextMime('text/html')).toBe(true)
    expect(isTextMime('image/png')).toBe(false)
  })
})

describe('fileViewerKind', () => {
  test('classifies in priority order', () => {
    expect(fileViewerKind({ mime: 'audio/mpeg' })).toBe('audio')
    expect(fileViewerKind({ mime: 'image/png' })).toBe('image')
    expect(fileViewerKind({ mime: 'application/pdf' })).toBe('pdf')
    expect(fileViewerKind({ mime: 'text/html' })).toBe('html')
    expect(fileViewerKind({ mime: 'text/markdown' })).toBe('markdown')
    expect(fileViewerKind({ mime: 'text/plain', name: 'doc.md' })).toBe('markdown')
    expect(fileViewerKind({ mime: 'text/plain' })).toBe('text')
    expect(fileViewerKind({ mime: 'application/zip' })).toBe('none')
  })
})

describe('fileIconName', () => {
  test('picks an icon per kind', () => {
    expect(fileIconName({ mime: 'image/png' })).toBe('image')
    expect(fileIconName({ mime: 'application/pdf' })).toBe('file-text')
    expect(fileIconName({ mime: 'text/html' })).toBe('code')
    expect(fileIconName({ mime: 'text/markdown' })).toBe('file-text')
    expect(fileIconName({ mime: 'audio/mpeg' })).toBe('music')
    expect(fileIconName({ mime: 'application/zip' })).toBe('file')
  })
})

describe('extensionForMime (non-audio additions)', () => {
  test('maps image, html, markdown, pdf mimes', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('text/html')).toBe('html')
    expect(extensionForMime('text/markdown')).toBe('md')
    expect(extensionForMime('application/pdf')).toBe('pdf')
  })
})

describe('approxBytesFromBase64', () => {
  test('estimates decoded size from base64 length', () => {
    // "hi" -> "aGk=" (1 pad char) -> 2 bytes
    expect(approxBytesFromBase64('aGk=')).toBe(2)
    // "man" -> "bWFu" (no padding) -> 3 bytes
    expect(approxBytesFromBase64('bWFu')).toBe(3)
    // "a" -> "YQ==" (2 pad chars) -> 1 byte
    expect(approxBytesFromBase64('YQ==')).toBe(1)
    expect(approxBytesFromBase64('')).toBe(0)
  })
})

describe('formatBytes', () => {
  test('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 * 1024 * 3.4)).toBe('3.4 MB')
    expect(formatBytes(1024 * 1024 * 20)).toBe('20 MB')
  })
})
