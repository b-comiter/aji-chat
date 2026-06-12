import type { ReactNode } from 'react'
import { Text } from 'react-native'
import hljs from 'highlight.js'
import type { ThemeColors } from '../../constants/theme'

// Shebang interpreter → highlight.js language id. Lets unlabeled fenced blocks
// that are obviously scripts still get highlighted (sh/bash being the common one).
const SHEBANG_LANGS: Record<string, string> = {
  bash: 'bash',
  sh: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  dash: 'bash',
  python: 'python',
  python3: 'python',
  node: 'javascript',
  deno: 'javascript',
  ruby: 'ruby',
  perl: 'perl',
}

/**
 * Resolve the highlight language for a fenced code block. Prefers an explicit,
 * valid fence language; otherwise infers from a shebang on the first line (so a
 * ```` ``` ```` block holding a `#!/usr/bin/env bash` script still highlights).
 * Returns undefined when nothing is confident (rendered as plain text).
 */
export function inferLanguage(code: string, language: string | undefined): string | undefined {
  if (language && hljs.getLanguage(language)) return language

  const nl = code.indexOf('\n')
  const firstLine = (nl === -1 ? code : code.slice(0, nl)).trim()
  if (!firstLine.startsWith('#!')) return undefined

  const parts = firstLine.slice(2).trim().split(/\s+/)
  // `#!/usr/bin/env bash` → use the word after env; `#!/bin/bash` → the basename.
  const basename = (p: string) => p.split('/').pop()?.toLowerCase() ?? ''
  let interp = basename(parts[0] ?? '')
  if (interp === 'env' && parts[1]) interp = basename(parts[1])

  const resolved = SHEBANG_LANGS[interp]
  return resolved && hljs.getLanguage(resolved) ? resolved : undefined
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
}

// Syntax-highlight `code` into an array of lines, each line an array of styled
// nodes. Splitting by line (rather than one flat node list with embedded "\n")
// lets the inline preview render each line as its own <Text numberOfLines={1}>,
// so long lines clip with an ellipsis instead of wrapping — the key to a compact
// preview that can't grow tall. The full-screen viewer renders every line.
export function highlightCodeLines(
  code: string,
  language: string | undefined,
  colors: ThemeColors,
  tokenColors: Record<string, string>,
): ReactNode[][] {
  const splitPlain = (text: string): ReactNode[][] =>
    text.split('\n').map((line) => (line ? [line] : []))

  if (!language || !hljs.getLanguage(language)) return splitPlain(code)

  try {
    const { value: html } = hljs.highlight(code, { language, ignoreIllegals: true })
    const lines: ReactNode[][] = []
    let current: ReactNode[] = []
    let key = 0
    let i = 0
    const n = html.length
    const stack: Array<{ color: string; token?: string }> = [{ color: colors.text }]

    // Append a (possibly multi-line) text chunk, breaking it into lines as it goes.
    const emit = (text: string, styled: boolean, style: any) => {
      const parts = text.split('\n')
      parts.forEach((part, idx) => {
        if (idx > 0) {
          lines.push(current)
          current = []
        }
        if (part) {
          current.push(styled ? <Text key={`hl-${key++}`} style={style}>{part}</Text> : part)
        }
      })
    }

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
          emit(text, top.color !== colors.text, style)
        }
        i = end === -1 ? n : end
      }
    }
    lines.push(current)
    return lines.length > 0 ? lines : splitPlain(code)
  } catch {
    return splitPlain(code)
  }
}
