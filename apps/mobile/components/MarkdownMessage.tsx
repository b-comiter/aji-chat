import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useColorScheme, View } from 'react-native'
import { useMarkdown, type MarkedStyles, Renderer } from 'react-native-marked'
import { typography } from '../constants/theme'
import type { ThemeColors } from '../constants/theme'
import { useTheme } from '../context/ThemeContext'
import { CodeBlock, CodeSelectableContext } from './markdown/CodeBlock'
import { MarkdownTable } from './markdown/MarkdownTable'

// ---------------------------------------------------------------------------
// Renderer — one instance per MarkdownMessage (via useMemo) so the slug-based
// key counter never collides between concurrently-rendered messages. Code blocks
// and tables are interactive components that manage their own theme/state.
// ---------------------------------------------------------------------------
class CustomRenderer extends Renderer {
  code(text: string, language?: string) {
    return <CodeBlock key={this.getKey()} code={text} language={language} />
  }

  table(header: ReactNode[][], rows: ReactNode[][][]) {
    return <MarkdownTable key={this.getKey()} header={header} rows={rows} />
  }
}

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
    // Table grid styles intentionally omitted — CustomRenderer.table() renders
    // an interactive MarkdownTable, not a MarkedStyles-driven grid.
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
interface MarkdownMessageProps {
  content: string
  /** Whether code blocks render selectable text. Off in the chat row so the
   *  long-press message menu isn't shadowed by iOS's native copy callout. */
  selectable?: boolean
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
  if (!rawInput) return ''

  return rawInput
    // 1. Force raw '\\n' strings from API responses into real bytes
    .replace(/\\n/g, '\n')

    // 2. CRITICAL: Inject an extra newline before bold keys.
    .replace(/\n(\*\*)/g, '\n\n$1')

    // 3. Optional: Convert loose double-space indentation lines into clean bullet points
    .replace(/\n  (Recent|Tools|Last)/g, '\n* $1')

    // 4. Clean up LLM formatting errors with single quotes (e.g., **'text'** -> **text**)
    .replace(/\*\*\'([^*'\n]+?)\'\*\*/g, '**$1**')

    // 5. Restructure ONLY bulleted lines with backticks. Work around for render bug.
    // Matches a bullet line starting with - or *, finds the bold block, captures the inner parts.
    .replace(/^([\s]*[-*]\s+)\*\*(.*?)\*\*/gm, (match, bullet, content) => {
      if (!content.includes('`')) return match

      // Extract text content and code content regardless of which comes first
      const code = content.match(/`([^`]+?)`/)?.[1]
      const text = content.replace(/`[^`]+?`/g, '').replace(/^[\s\W:-]+|[\s\W:-]+$/g, '').trim()

      // Return unified, readable layout: "- **Text:** `code`"
      return code && text ? `${bullet}**${text}:** \`${code}\`` : match
    })
}

export function MarkdownMessage({ content, selectable = true }: MarkdownMessageProps) {
  const { colors } = useTheme()
  const colorScheme = useColorScheme()

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

  // Per-instance renderer so the slug key counter doesn't collide across messages.
  const renderer = useMemo(() => new CustomRenderer(), [])

  // useMarkdown parses to an array of RN elements. We render them in a plain View
  // rather than react-native-marked's <Markdown> (which wraps them in a FlatList).
  // A FlatList nested inside the chat screen's outer inverted FlatList can't
  // virtualize — it renders only ~8 blocks and reserves blank space for the rest.
  const elements = useMarkdown(normalizedContent, {
    styles: mdStyles,
    theme: markdownTheme,
    renderer,
    colorScheme: colorScheme ?? undefined,
  })

  return (
    <CodeSelectableContext.Provider value={selectable}>
      <View>{elements}</View>
    </CodeSelectableContext.Provider>
  )
}
