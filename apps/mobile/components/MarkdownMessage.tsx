import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import hljs from 'highlight.js'
import Markdown, { type MarkedStyles, Renderer } from 'react-native-marked'
import { colors, tokenColors, typography } from '../constants/theme'

// Brand colors for popular languages — used as the dot indicator in the header
const LANG_COLORS: Record<string, string> = {
  python:     '#3572A5',
  javascript: '#F7DF1E',
  js:         '#F7DF1E',
  typescript: '#3178C6',
  ts:         '#3178C6',
  rust:       '#DEA584',
  go:         '#00ADD8',
  ruby:       '#CC342D',
  java:       '#B07219',
  kotlin:     '#A97BFF',
  swift:      '#FA7343',
  'c++':      '#F34B7D',
  cpp:        '#F34B7D',
  c:          '#555555',
  'c#':       '#239120',
  csharp:     '#239120',
  php:        '#4F5D95',
  html:       '#E34C26',
  css:        '#563D7C',
  scss:       '#C6538C',
  sql:        '#336791',
  shell:      '#89E051',
  bash:       '#89E051',
  sh:         '#89E051',
  yaml:       '#CB171E',
  yml:        '#CB171E',
  json:       '#40BF8A',
  docker:     '#2496ED',
  dockerfile: '#2496ED',
  r:          '#198CE7',
  scala:      '#C22D40',
  elixir:     '#6E4A7E',
  haskell:    '#5E5086',
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}


function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
}

function highlightCode(code: string, language?: string): React.ReactNode[] {
  if (!language) return [code]
  try {
    const { value: html } = hljs.highlight(code, { language, ignoreIllegals: true })
    const elements: React.ReactNode[] = []
    let key = 0
    let i = 0
    const n = html.length
    // Stack tracks the active token and color as spans open/close (handles nesting)
    const stack: Array<{ color: string; token?: string }> = [{ color: colors.text }]

    while (i < n) {
      if (html[i] === '<') {
        const end = html.indexOf('>', i)
        if (end === -1) break
        const tag = html.slice(i, end + 1)
        if (tag.startsWith('<span')) {
          const cm = tag.match(/class="([^"]+)"/)
          if (cm) {
            const tokenType = cm[1].split(' ')[0].replace('hljs-', '')
            stack.push({ color: tokenColors[tokenType] ?? colors.text, token: tokenType })
          } else {
            stack.push({ ...stack[stack.length - 1] })
          }
        } else if (tag === '</span>') {
          if (stack.length > 1) stack.pop()
        }
        i = end + 1
      } else {
        const end = html.indexOf('<', i)
        const raw = end === -1 ? html.slice(i) : html.slice(i, end)
        if (raw) {
          const text = decodeHtmlEntities(raw)
          const top = stack[stack.length - 1]
          const style: any = { color: top.color }
          if (top.token === 'keyword') style.fontWeight = '600'
          if (top.token === 'function' || top.token === 'func' || top.token === 'title' || top.token === 'name') style.fontWeight = '600'
          if (top.token === 'comment') style.fontStyle = 'italic'

          // Emit raw string when using default color to keep tree lightweight
          elements.push(top.color === colors.text ? text : <Text key={key++} style={style}>{text}</Text>)
        }
        i = end === -1 ? n : end
      }
    }

    return elements.length > 0 ? elements : [code]
  } catch {
    return [code]
  }
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  async function handlePress() {
    await Clipboard.setStringAsync(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Pressable onPress={handlePress} style={codeStyles.copyBtn} hitSlop={8}>
      <Feather
        name={copied ? 'check' : 'copy'}
        size={14}
        color={copied ? '#40BF8A' : colors.textMuted} // copy-done green intentionally distinct from colors.success
      />
      <Text style={[codeStyles.copyLabel, copied && codeStyles.copyLabelDone]}>
        {copied ? 'Copied' : 'Copy'}
      </Text>
    </Pressable>
  )
}

class CustomRenderer extends Renderer {
  code(text: string, language?: string, containerStyle?: any, textStyle?: any) {
    const lang = language?.toLowerCase() ?? ''
    const dotColor = LANG_COLORS[lang] ?? colors.textDim
    const displayLang = language ?? 'plaintext'
    const codeBgColor = hexToRgba(dotColor, 0.08)
    const highlightedLines = highlightCode(text, language)

    return (
      <View style={codeStyles.block}>
        <View style={codeStyles.header}>
          <View style={[codeStyles.dot, { backgroundColor: dotColor }]} />
          <Text style={codeStyles.lang}>{displayLang}</Text>
          <CopyButton code={text} />
        </View>
        <View style={codeStyles.divider} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ minWidth: '100%' }}
        >
          <View style={[codeStyles.codeContainer, { backgroundColor: codeBgColor }]}>
            <Text style={codeStyles.code} selectable>
              {highlightedLines}
            </Text>
          </View>
        </ScrollView>
      </View>
    )
  }
}

const customRenderer = new CustomRenderer()

const codeStyles = StyleSheet.create({
  block: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderCode,
    overflow: 'hidden',
    marginVertical: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.bg,
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  lang: {
    color: colors.textMuted,
    fontSize: typography.sizeSm,
    fontFamily: typography.fontMono,
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderCode,
  },
  codeContainer: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    width: '100%',
  },
  code: {
    fontFamily: typography.fontMono,
    fontSize: typography.sizeMd,
    lineHeight: typography.lineHeightCode,
    color: colors.text,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  copyLabel: {
    fontSize: typography.sizeXs,
    color: colors.textMuted,
  },
  copyLabelDone: {
    color: '#40BF8A', // copy-done green, intentionally distinct from colors.success
  },
})

const theme = {
  colors: {
    text:   colors.text,
    link:   colors.accent,
    code:   'transparent',
    border: colors.border,
  },
}

const mdStyles: MarkedStyles = {
  text: { fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal },
  paragraph: { marginVertical: 2 },
  strong: { fontWeight: 'bold', color: colors.text },
  em: { fontStyle: 'italic', color: colors.text },
  h1: { fontSize: typography.size2xl, fontWeight: typography.weightBold, color: colors.text, marginTop: 8, marginBottom: 4 },
  h2: { fontSize: typography.sizeXl, fontWeight: typography.weightBold, color: colors.text, marginTop: 6, marginBottom: 4 },
  h3: { fontSize: typography.sizeLg, fontWeight: typography.weightBold, color: colors.text, marginTop: 4, marginBottom: 2 },
  codespan: { fontFamily: typography.fontMono, fontSize: typography.sizeMd, color: colors.tool, backgroundColor: colors.surface2, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4, fontStyle: 'normal' },
  code: { backgroundColor: colors.surface, borderRadius: 8 },
  blockquote: { borderLeftWidth: 3, borderLeftColor: colors.textMuted, paddingLeft: 10 },
  li: { fontSize: typography.sizeLg, color: colors.text },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 4 },
  tableRow: { minHeight: 36 },
  tableCell: { paddingHorizontal: 10, paddingVertical: 6 },
}

const flatListStyle = { backgroundColor: 'transparent' } as const

// React Native bug on iOS/Android: fontWeight on a nested <Text> doesn't
// render when that element immediately follows a \n in the parent text node.
// A paragraph break (\n\n) makes react-native-marked render bold/italic in
// its own <View>, bypassing the bug. We preserve code blocks from normalization
// to avoid breaking their syntax.
function normalizeNewlines(md: string): string {
  if (Platform.OS === 'web') return md

  const codeBlocks: string[] = []
  let normalized = md.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`
  })

  normalized = normalized.replace(/(?<!\n)\n(\*{1,2}\S|_{1,2}\S)/g, '\n\n$1')

  codeBlocks.forEach((block, i) => {
    normalized = normalized.replace(`__CODE_BLOCK_${i}__`, block)
  })

  return normalized
}

type Props = { content: string }

export function MarkdownMessage({ content }: Props) {
  return (
    <Markdown
      value={normalizeNewlines(content)}
      theme={theme}
      styles={mdStyles}
      renderer={customRenderer}
      flatListProps={{ scrollEnabled: false, style: flatListStyle }}
    />
  )
}
