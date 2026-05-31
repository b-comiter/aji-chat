import * as Clipboard from 'expo-clipboard'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import hljs from 'highlight.js'
import Markdown, { type MarkedStyles, Renderer } from 'react-native-marked'
import { typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'

// Brand colors for popular languages — used as the dot indicator in the header.
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

// Global caching engine for calculated background highlights
const CODE_BG_CACHE: Record<string, string> = {}
function getCachedBgColor(hex: string): string {
  if (CODE_BG_CACHE[hex]) return CODE_BG_CACHE[hex]
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return 'rgba(128, 128, 128, 0.08)'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const rgba = `rgba(${r}, ${g}, ${b}, 0.08)`
  CODE_BG_CACHE[hex] = rgba
  return rgba
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|'|&apos;/g, "'")
}

function highlightCode(
  code: string,
  language: string | undefined,
  colors: ThemeColors,
  tokenColors: Record<string, string>,
): React.ReactNode[] {
  if (!language || !hljs.getLanguage(language)) return [code]

  try {
    const { value: html } = hljs.highlight(code, { language, ignoreIllegals: true })
    const elements: React.ReactNode[] = []
    let i = 0
    const n = html.length
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
          if (['function', 'func', 'title', 'name'].includes(top.token || '')) style.fontWeight = '600'
          if (top.token === 'comment') style.fontStyle = 'italic'

          // Use structural offset template keys for stable, zero-glitch reconciliation loops
          elements.push(top.color === colors.text ? text : <Text key={`hl-${i}`} style={style}>{text}</Text>)
        }
        i = end === -1 ? n : end
      }
    }

    return elements.length > 0 ? elements : [code]
  } catch {
    return [code]
  }
}

// ---------------------------------------------------------------------------
// Code block styles — extracted so CodeBlock can memoize per theme change
// ---------------------------------------------------------------------------
function makeCodeStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
  })
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------
const copyBtnStyles = StyleSheet.create({
  btn:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: typography.sizeXs },
})

function CopyButton({ code }: { code: string }) {
  const { colors } = useTheme()
  const [copied, setCopied] = useState(false)
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  async function handlePress() {
    await Clipboard.setStringAsync(code)
    setCopied(true)
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current)
    }
    resetTimeoutRef.current = setTimeout(() => {
      setCopied(false)
      resetTimeoutRef.current = null
    }, 2000)
  }

  const iconColor  = copied ? '#40BF8A' : colors.textMuted
  const labelColor = copied ? '#40BF8A' : colors.textMuted

  return (
    <Pressable onPress={handlePress} style={copyBtnStyles.btn} hitSlop={8}>
      <Feather name={copied ? 'check' : 'copy'} size={14} color={iconColor} />
      <Text style={[copyBtnStyles.label, { color: labelColor }]}>
        {copied ? 'Copied' : 'Copy'}
      </Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// CodeBlock — proper React component so highlight result can be memoized
// ---------------------------------------------------------------------------
function CodeBlock({ code, language }: { code: string; language?: string }) {
  const { colors, tokenColors } = useTheme()
  const styles = useMemo(() => makeCodeStyles(colors), [colors])

  const lang = language?.toLowerCase() ?? ''
  const dotColor = LANG_COLORS[lang] ?? colors.textDim
  const displayLang = language ?? 'plaintext'

  const codeBgColor = useMemo(() => getCachedBgColor(dotColor), [dotColor])
  const highlightedLines = useMemo(
    () => highlightCode(code, language, colors, tokenColors),
    [code, language, colors, tokenColors],
  )

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.lang}>{displayLang}</Text>
        <CopyButton code={code} />
      </View>
      <View style={styles.divider} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ minWidth: '100%' }}
      >
        <View style={[styles.codeContainer, { backgroundColor: codeBgColor }]}>
          <Text style={styles.code} selectable>
            {highlightedLines}
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Renderer — thin singleton; CodeBlock handles all theming internally
// ---------------------------------------------------------------------------

class CustomRenderer extends Renderer {
  code(text: string, language?: string) {
    return <CodeBlock code={text} language={language} />
  }
}

const sharedRenderer = new CustomRenderer()

// ---------------------------------------------------------------------------
// Markdown styles
// ---------------------------------------------------------------------------

function makeMdStyles(colors: ThemeColors): MarkedStyles {
  return {
    text: { fontSize: typography.sizeLg, lineHeight: typography.lineHeightNormal, color: colors.text },
    paragraph: { marginVertical: 2 },
    strong: { fontWeight: 'bold', color: colors.text },
    em: { fontStyle: 'italic', color: colors.text },
    h1: { fontSize: typography.size2xl, fontWeight: '700', color: colors.text, marginTop: 8, marginBottom: 4 },
    h2: { fontSize: typography.sizeXl, fontWeight: '700', color: colors.text, marginTop: 6, marginBottom: 4 },
    h3: { fontSize: typography.sizeLg, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 2 },
    codespan: { fontFamily: typography.fontMono, fontSize: typography.sizeMd, color: colors.tool,
      backgroundColor: colors.surface2, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4,
      fontStyle: 'normal' },
    code: { backgroundColor: colors.surface, borderRadius: 8 },
    blockquote: { borderLeftWidth: 3, borderLeftColor: colors.textMuted, paddingLeft: 10 },
    li: { fontSize: typography.sizeLg, color: colors.text },
    table: { borderWidth: 1, borderColor: colors.border, borderRadius: 4 },
    tableRow: { minHeight: 36 },
    tableCell: { paddingHorizontal: 10, paddingVertical: 8 },
  }
}

// ---------------------------------------------------------------------------
// Main Export Component Wrapper
// ---------------------------------------------------------------------------
interface MarkdownMessageProps {
  content: string
}

/**
 * Normalizes input text strings for the React Native Markdown parser.
 * 
 * Why this is required in React Native vs. Web:
 * 1. Native API payloads frequently transmit literal escape characters ("\\n") 
 *    instead of real line-break bytes, which standard parsers render as raw text.
 * 
 * 2. Unlike web-based markdown engines (like marked.js) which handle single 
 *    newlines gracefully using HTML <br/> tags, native mobile engines rely on strict 
 *    paragraph boundaries. Continuous layouts like "\n**Text**" break the internal 
 *    Lexer tokenization loops, causing bold style rules to fail silently. 
 * 
 * 3. Forcing a double newline ("\n\n**") isolates metadata segments into discrete, 
 *    valid paragraph components that native layout blocks can safely process.
 * 
 * 4. React Native markdown renderers split elements into separate native UI <Text> 
 *    and <View> tokens. The engine fails to apply bold formatting styles to a 
 *    text line if it immediately follows or surrounds an inline `code` snippet. 
 *    To circumvent this layout engine defect on bullet items, mixed formatting 
 *    is flattened into a safe, linear sequence: "**Text:** `code`".
 */
function normalizeMarkdownInput(rawInput: string): string {
  if (!rawInput) return '';

  return rawInput
    // 1. Force raw '\\n' strings from API responses into real bytes
    .replace(/\\n/g, '\n')
    
    // 2. CRITICAL: Inject an extra newline before bold keys.
    .replace(/\n(\*\*)/g, '\n\n$1')
    
    // 3. Optional: Convert loose double-space indentation lines into clean bullet points
    .replace(/\n  (Recent|Tools|Last)/g, '\n* $1')

    // 4. Clean up LLM formatting errors with single quotes (e.g., **'text'** -> **text**)
    .replace(/\*\*\'([^*'\n]+?)\'\*\*/g, '**$1**')

    // 5. Restructure ONLY bulleted lines with backticks Work around for render bug 
    // This matches a bullet line starting with - or *, finds the bold block, and captures the inner parts.
    .replace(/^([\s]*[-*]\s+)\*\*(.*?)\*\*/gm, (match, bullet, content) => {
      if (!content.includes('`')) return match;

      // Extract text content and code content regardless of which comes first
      const code = content.match(/`([^`]+?)`/)?.[1];
      const text = content.replace(/`[^`]+?`/g, '').replace(/^[\s\W:-]+|[\s\W:-]+$/g, '').trim();

      // Return unified, readable layout: "- **Text:** `code`"
      return code && text ? `${bullet}**${text}:** \`${code}\`` : match;
    });
}

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  const { colors } = useTheme()

  const normalizedContent = useMemo(() => normalizeMarkdownInput(content), [content])

  const mdStyles = useMemo(() => makeMdStyles(colors), [colors])

  const markdownTheme = useMemo(() => ({
      colors: {
        text:   colors.text,
        link:   colors.accent,
        code:   'transparent',
        border: colors.border,
      },
    }), [colors])

  return (
      <Markdown 
        value={normalizedContent} 
        renderer={sharedRenderer} 
        styles={mdStyles} 
        theme={markdownTheme} 
        flatListProps={{ 
          style: { backgroundColor: 'transparent' },
          contentContainerStyle: { backgroundColor: 'transparent' }
        }} 
      />
  )
}

