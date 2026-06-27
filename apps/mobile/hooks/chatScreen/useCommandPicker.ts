import { useMemo } from 'react'
import type { CommandItem } from '@aji/protocol'
import { LOCAL_COMMANDS } from '../useChatActions'

export function useCommandPicker(draft: string, commands: CommandItem[]) {
  const allCommands = useMemo(() => [...LOCAL_COMMANDS, ...commands], [commands])

  const modelSubcommands = useMemo(
    () => allCommands.find((c) => c.name === 'model')?.subcommands ?? [],
    [allCommands],
  )

  const trimmedDraft = useMemo(() => draft.trim(), [draft])
  const rawQuery = trimmedDraft.startsWith('/') ? trimmedDraft.slice(1) : null
  const pickerQuery = rawQuery !== null && !rawQuery.includes(' ') ? rawQuery.toLowerCase() : null

  const pickerItems = useMemo(() => {
    if (pickerQuery === null) return []
    return allCommands
      .filter(
        (c) =>
          c.name.toLowerCase().startsWith(pickerQuery) ||
          (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(pickerQuery)),
      )
      .slice(0, 20)
  }, [pickerQuery, allCommands])

  return { modelSubcommands, trimmedDraft, pickerItems }
}
