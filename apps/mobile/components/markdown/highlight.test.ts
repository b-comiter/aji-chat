import { inferLanguage, inferLanguageFromPath } from './highlight'

describe('inferLanguage', () => {
  it('honors an explicit, valid fence language', () => {
    expect(inferLanguage('print("hi")', 'python')).toBe('python')
    expect(inferLanguage('echo hi', 'bash')).toBe('bash')
  })

  it('infers bash from common shell shebangs', () => {
    expect(inferLanguage('#!/usr/bin/env bash\nset -e', undefined)).toBe('bash')
    expect(inferLanguage('#!/bin/bash\nls', undefined)).toBe('bash')
    expect(inferLanguage('#!/bin/sh\nls', undefined)).toBe('bash')
    expect(inferLanguage('#!/usr/bin/env zsh', undefined)).toBe('bash')
  })

  it('infers other interpreters from their shebang', () => {
    expect(inferLanguage('#!/usr/bin/env python3\nx = 1', undefined)).toBe('python')
    expect(inferLanguage('#!/usr/bin/python -u\nx = 1', undefined)).toBe('python')
    expect(inferLanguage('#!/usr/bin/env node', undefined)).toBe('javascript')
  })

  it('returns undefined when there is no language and no shebang', () => {
    expect(inferLanguage('just some text\nmore text', undefined)).toBeUndefined()
    expect(inferLanguage('SELECT 1', undefined)).toBeUndefined()
  })

  it('falls back to the shebang when the fence language is unknown', () => {
    expect(inferLanguage('#!/bin/bash\nls', 'not-a-language')).toBe('bash')
  })

  it('ignores shebangs for interpreters we do not map', () => {
    expect(inferLanguage('#!/usr/bin/env elvish', undefined)).toBeUndefined()
  })
})

describe('inferLanguageFromPath', () => {
  it('resolves common extensions to their grammar', () => {
    expect(inferLanguageFromPath('src/app.ts')).toBe('typescript')
    expect(inferLanguageFromPath('components/Chat.tsx')).toBe('typescript')
    expect(inferLanguageFromPath('/abs/path/main.py')).toBe('python')
    expect(inferLanguageFromPath('lib/foo.rb')).toBe('ruby')
    expect(inferLanguageFromPath('server.go')).toBe('go')
    expect(inferLanguageFromPath('styles.css')).toBe('css')
    expect(inferLanguageFromPath('data.json')).toBe('json')
  })

  it('is case-insensitive and uses the last extension', () => {
    expect(inferLanguageFromPath('README.MD')).toBe('markdown')
    expect(inferLanguageFromPath('archive.tar.gz')).toBeUndefined()
    expect(inferLanguageFromPath('Component.test.tsx')).toBe('typescript')
  })

  it('handles extension-less filenames that map to a grammar', () => {
    expect(inferLanguageFromPath('Dockerfile')).toBe('dockerfile')
    expect(inferLanguageFromPath('docker/Dockerfile')).toBe('dockerfile')
    expect(inferLanguageFromPath('Makefile')).toBe('makefile')
  })

  it('returns undefined for unknown, missing, or dotfile-only names', () => {
    expect(inferLanguageFromPath(undefined)).toBeUndefined()
    expect(inferLanguageFromPath('notes.xyz')).toBeUndefined()
    expect(inferLanguageFromPath('LICENSE')).toBeUndefined()
    expect(inferLanguageFromPath('.gitignore')).toBeUndefined()
  })
})
