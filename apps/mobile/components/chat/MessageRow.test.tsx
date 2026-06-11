import { render, waitFor } from '@testing-library/react-native'
import type { Item } from '../../hooks/chatTypes'

// MarkdownMessage pulls in react-native-marked (ESM `marked`, untransformed by
// jest) and is only used by the text-message branch — stub it so the file
// branch can render in isolation.
jest.mock('../MarkdownMessage', () => ({ MarkdownMessage: () => null }))

import { Row } from './MessageRow'

// Native modules expo-audio + expo-file-system aren't available under jest;
// mock just enough for AudioMessage to render its controls.
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 1 }),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
}))

const noop = () => {}

function renderRow(item: Item) {
  return render(
    <Row
      item={item}
      onChoose={noop}
      isGroupStart
      dividerKind="none"
      tools={[]}
      avatarLabel="SI"
      onOpenTools={noop}
      onOpenFile={noop}
    />,
  )
}

describe('Row — file items', () => {
  test('renders an audio file as a playable bubble with caption + duration', async () => {
    const item: Item = {
      kind: 'file',
      id: 'file_1',
      role: 'assistant',
      mime: 'audio/mpeg',
      data: 'AAAA',
      name: 'sample.mp3',
      duration: 1,
      text: 'Here is a voice clip.',
      done: true,
    }
    const screen = renderRow(item)
    expect(screen.getByText('Here is a voice clip.')).toBeTruthy()
    expect(screen.getByText('0:00 / 0:01')).toBeTruthy()
    // Let the cache-write effect settle so we don't leak an act() warning.
    await waitFor(() => {})
  })

  test('renders an image file as a tappable inline thumbnail', () => {
    const item: Item = {
      kind: 'file',
      id: 'file_2',
      role: 'assistant',
      mime: 'image/png',
      data: 'AAAA',
      name: 'photo.png',
      done: true,
    }
    const screen = renderRow(item)
    expect(screen.getByLabelText('Image photo.png')).toBeTruthy()
  })

  test('renders a document file as a tappable chip with name + type', () => {
    const item: Item = {
      kind: 'file',
      id: 'file_3',
      role: 'assistant',
      mime: 'text/html',
      data: 'AAAA',
      name: 'report.html',
      done: true,
    }
    const screen = renderRow(item)
    expect(screen.getByText('report.html')).toBeTruthy()
    expect(screen.getByLabelText('Open file report.html')).toBeTruthy()
  })
})
