import { inferLanguage } from './highlight'

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
