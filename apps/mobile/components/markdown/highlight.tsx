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

// Common file extensions → highlight.js language id, for highlighting a diff by
// its filename. `getLanguage` guards each lookup, so an extension whose grammar
// isn't in this build resolves to undefined (rendered as plain text).
const EXT_LANGS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  lua: 'lua', r: 'r', dart: 'dart', pl: 'perl', pm: 'perl', ex: 'elixir', exs: 'elixir',
}

// Extension-less filenames that still map to a grammar.
const FILENAME_LANGS: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
}

/**
 * Resolve the highlight language from a file path's extension (or a bare,
 * extension-less filename like `Dockerfile`). Returns undefined when there's no
 * confident match — the diff then renders as plain (but still tinted) text.
 */
export function inferLanguageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const name = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (!name) return undefined

  const byName = FILENAME_LANGS[name]
  if (byName) return hljs.getLanguage(byName) ? byName : undefined

  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined // no extension, or a dotfile like `.gitignore`
  const lang = EXT_LANGS[name.slice(dot + 1)]
  return lang && hljs.getLanguage(lang) ? lang : undefined
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
