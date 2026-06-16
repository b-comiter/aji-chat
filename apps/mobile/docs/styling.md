# Styling Guide

aji-chat uses a consistent, theme-aware design system inspired by GitHub's interface. All styling is centralized in design tokens that support both dark and light modes automatically.

## Mockup → Implementation Roadmap

This section is a checklist of UI patterns and their implementation status. Implement each in the React Native file listed in the **Implementation notes** column.

### Chat Screen Patterns

| # | Pattern | Description | Implementation notes | Status |
|---|---------|-------------|---------------------|--------|
| 1 | **Avatar positioning** ✓ | Avatars sit *above* the first message in a turn or sequence, not beside it. The message body uses the full available width. | Avatars rendered in `msgMeta` row above message text. Avatar size: 28×28px. Reusable `Avatar()` component supports agent/user variants. | **COMPLETE** (Phase 1) |
| 2 | **Soft bottom borders between messages** ✓ | Each message has a subtle 1px bottom border (`colors.border`) to show that messages did not all arrive simultaneously. Last message in the list has no border. | `msgBorder` style uses `StyleSheet.hairlineWidth` (1px) with conditional application via `!isLast` check. | **COMPLETE** (Phase 1) |
| 3 | **Message grouping (avatar deduplication)** ✓ | Consecutive messages from the same sender are grouped: avatar and author/timestamp only appear on the *first* message in the group. Subsequent messages from the same sender hide the avatar and header. | `computeIsGroupStart()` helper compares role/turnId with previous item. Avatars rendered only when `isGroupStart === true`. | **COMPLETE** (Phase 1) |
| 4 | **Tool call aggregation per turn** ✓ | Tool calls from a single agent turn are bundled into a single badge (e.g., "🔧 3 tool calls") attached to the agent's message, rather than rendered as individual entries. Tapping the badge opens a bottom sheet with full details. | `ToolBadge` component shows count and taps to trigger `onSelectTools()`. Tools collected by `turnId` in FlatList `renderItem` and passed to `Row`. | **COMPLETE** (Phase 3) |
| 5 | **Bottom sheet for tool details** ✓ | Tool call details live in a slide-up bottom sheet (not inline). The sheet shows expanded tool cards with args and results. | `ToolDetailSheet` modal component using React Native `Modal` with slide animation. Pass selected `turnId` to filter tools. Close button dismisses. | **COMPLETE** (Phase 3) |
| 6 | **Plain text vs. tool message styling** ✓ | Messages with no tool calls or attachments use *transparent* background (no bubble). Messages with tool calls, media, or attachments use a `colors.surface` background with a border. | `showBubble` flag computed as `isUser || hasTool`. Conditional styling applies `bubble` + variant classes only when `showBubble === true`. | **COMPLETE** (Phase 1) |
| 7 | **User message styling** ✓ | User messages are right-aligned, use `colors.accent` background with white text, max-width 85%, no author header (just the bubble). | User messages render with `bubbleUser` style (accent bg, white text). Avatar on right via normal flex order. Max-width enforced via style. | **COMPLETE** (Phase 1) |
| 8 | **Markdown rendering** | Agent messages render markdown (fenced code blocks with syntax highlighting via `highlight.js`, bold/italic, lists, links, inline code). User messages render as plain text. | [`components/MarkdownMessage.tsx`](../components/MarkdownMessage.tsx) already exists and is invoked for completed assistant messages. | **EXISTING** (no changes) |
| 9 | **Animated status indicator in chat header** ✓ | The chat header shows an animated pulse dot indicating agent state: green for "idle", orange for "thinking", blue for "working". Pulsing animation while active. | `pulseScale` Animated.Value loops a sequence (1.0→1.3→1.0 over 1.2s). `StatusIndicator` component colors by `agentStatus`. Resets to 1 on idle. | **COMPLETE** (Phase 2) |

### Prompts & Interactivity

| # | Pattern | Description | Implementation notes | Status |
|---|---------|-------------|---------------------|--------|
| 10 | **Prompt response persistence + summary stub** | When a permission prompt or multi-step question is responded to, the full prompt card collapses into a compact summary stub showing what was selected (e.g., "✓ Allowed once · read MEMORY.md · 14:18"). The stub persists across app restarts. | **Requires DB schema change**: add `prompt_responses` table in [`db/database.ts`](../db/database.ts) with columns `id`, `prompt_id`, `chat_id`, `choice`, `responded_at`. Update `respond()` in `app/chat/[serverId]/[channelId].tsx` to insert the response and re-render the item as a stub instead of removing it. | **IN PROGRESS** (Phase 4) |
| 11 | **Multi-step question prompts** | Question prompts can have a step indicator (e.g., "1/3") and an "Other" option with a text input. The composer is disabled while waiting on a response. | Extend `PromptOption` type in [`packages/protocol/src/index.ts`](../../../packages/protocol/src/index.ts) to support step metadata. Render an "Other" option with an inline `TextInput` that submits as a custom response. | **PLANNED** (Phase 5) |
| 12 | **Permission request rationale card** | Permission requests show: title, scope badge (e.g., "project (local)"), description, code snippet of what will run, rationale text, and three action buttons (Deny, Always allow, Allow once). | Extend the prompt renderer in `Row()` to handle `kind: 'prompt'` items with a `scope` and `code` payload. Style with `attention` class equivalent (warn-colored border + glow). | **PLANNED** (Phase 5) |

### Settings & Navigation

| # | Pattern | Description | Implementation notes | Status |
|---|---------|-------------|---------------------|--------|
| 13 | **Settings screen sectioned layout** ✓ | Settings uses a card-based layout grouped by section: Appearance (theme segmented control), Connection (server URL), Data (clear history button), About (version/SDK). | Already implemented in [`app/settings.tsx`](../app/settings.tsx) — verified against mockup with theme toggle, server URL display, and destructive button styling. | **COMPLETE** |
| 14 | **Channel list with sections** | The home screen lists channels grouped into "Inbox", "Channels", and "Direct" sections. Each row shows: icon/avatar (with online/idle dot for agents), name, last message preview, timestamp, and unread count badge. | Implement section labels in the FlatList using `SectionList`. Add online/idle indicator dots overlaid on agent avatars. Add unread badge using `colors.accent` background. | **PLANNED** (Phase 6) |
| 15 | **Inbox aggregated channel** | The "Inbox" channel acts as a triaged feed of messages from multiple agents — distinct icon (gradient blue) and shows the most recent message across all channels. | Likely a virtual channel (no real chatId) that queries the most recent N messages across all chats. Add a special handler in the home screen routing. | **PLANNED** (Phase 6) |

### Implementation Progress

**Phases Completed:**
- **Phase 1** (#1–#3, #6–#7): Message visual polish — avatars, grouping, borders, bubble styling
- **Phase 2** (#9): Animated status indicator — pulsing dot with semantic colors
- **Phase 3** (#4–#5): Tool call aggregation — badge + bottom sheet modal

**Phases In Progress:**
- **Phase 4** (#10): Prompt response persistence — DB schema + summary stubs

**Phases Planned:**
- **Phase 5** (#11–#12): Prompt enhancements — multi-step questions, permission rationale
- **Phase 6** (#13–#15): Navigation & channel list — home screen, sections, unread badges

### Implementation Notes by File

**Core Chat Screen:** `app/chat/[serverId]/[channelId].tsx`
- Uses **inverted FlatList** (newest at visual bottom, oldest at top)
- Items stored chronologically; reversed only at FlatList boundary
- Computes `groupStartIds` Set and `newestId` once per items change for id-based lookups
- Calls `messageListRef.current?.scrollToBottom()` on Send
- FlatList renderItem uses id-based lookups (`groupStartIds.has(item.id)`, `item.id === newestId`)
- `Avatar` component (reusable, agent/user variants)
- `StatusIndicator` component (animated pulse for agent state)
- `ToolBadge` component (shows tool count, tap to open sheet)
- `ToolDetailSheet` modal (displays expanded tool details)
- `Row` renderer (messages, tools, prompts)

**Theme System:** `constants/theme.ts`
- Color palettes (dark/light) with semantic tokens (success, warn, danger, tool, etc.)
- Typography sizes and weights
- Spacing and border radius design tokens

**Database:** `db/database.ts`
- Item schema: `{ kind: 'message' | 'tool' | 'prompt', ...properties }`
- Incoming: Phase 4 will add `prompt_responses` table for persistence

**Markdown:** `components/MarkdownMessage.tsx`
- Renders agent messages as formatted markdown with syntax highlighting
- Already integrated, no changes needed for Phase 1–3

**Settings:** `app/settings.tsx`
- Theme toggle (Auto/Light/Dark)
- Server URL display
- Clear history button
- App version/SDK info

## Chat Scroll Architecture

See [`docs/chat-scroll-architecture.md`](../../../docs/chat-scroll-architecture.md) for detailed information about:
- Why we use an inverted FlatList (WhatsApp model)
- How pagination works when scrolling to visual top
- Why we don't save/restore scroll position (and why that's acceptable)
- Test coverage and debugging tips

This styling guide focuses on visual presentation; scroll behavior details are documented separately.

## Design Token System

All design decisions flow through a single source of truth: `constants/theme.ts`. This file defines colors, typography, spacing, and border radius values that are used throughout the app.

### Usage Pattern

Components access the current theme via the `useTheme()` hook:

```typescript
import { useTheme } from '../context/ThemeContext'

export function MyComponent() {
  const { colors, themePreference } = useTheme()
  
  const styles = useMemo(() => makeStyles(colors), [colors])
  return <Text style={styles.heading}>Hello</Text>
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    heading: {
      color: colors.text,
      fontSize: typography.size2xl,
      fontWeight: typography.weightSemibold,
    },
  })
}
```

## Color System

### Dark Theme (Default)

GitHub Dark palette for comfortable viewing in low-light conditions.

| Token | Value | Usage |
|-------|-------|-------|
| `bg` | `#0d1117` | Primary background |
| `surface` | `#161b22` | Cards, containers |
| `surface2` | `#1c2129` | Elevated surfaces |
| `surface3` | `#242b35` | Highest elevation |
| `border` | `#21262d` | Primary dividers |
| `borderAlt` | `#3a424d` | Secondary dividers |
| `text` | `#e6edf3` | Primary text |
| `textMuted` | `#8b949e` | Secondary text |
| `textDim` | `#6e7681` | Tertiary text (labels) |
| `accent` | `#5e8eff` | Links, buttons, highlights |
| `accentDim` | `#2d4380` | Accent background tint |
| `success` | `#3fb950` | Success states, ✓ icons |
| `warn` | `#d29922` | Warning states, attention |
| `danger` | `#f85149` | Destructive actions, errors |
| `tool` | `#b392f0` | Tool/function call badges |
| `toolDim` | `#4c3b73` | Tool badge background |

### Light Theme

GitHub Light palette for bright environments.

| Token | Value | Usage |
|-------|-------|-------|
| `bg` | `#ffffff` | Primary background |
| `surface` | `#f6f8fa` | Cards, containers |
| `surface2` | `#eaeef2` | Elevated surfaces |
| `surface3` | `#e0e4e9` | Highest elevation |
| `border` | `#d0d7de` | Primary dividers |
| `borderAlt` | `#adb5bd` | Secondary dividers |
| `text` | `#1f2328` | Primary text |
| `textMuted` | `#636c76` | Secondary text |
| `textDim` | `#818b98` | Tertiary text (labels) |
| `accent` | `#0969da` | Links, buttons, highlights |
| `accentDim` | `#dde6f5` | Accent background tint |
| `success` | `#1a7f37` | Success states |
| `warn` | `#9a6700` | Warning states |
| `danger` | `#d1242f` | Destructive actions |
| `tool` | `#8250df` | Tool/function call badges |
| `toolDim` | `#f1e8ff` | Tool badge background |

**Rationale:** Consistent colors across light/dark reduce cognitive load. Users recognize the same semantic meaning (accent = interaction, danger = destructive) regardless of theme.

## Typography

All type sizes, weights, and line heights are defined in `theme.ts` and remain constant across both themes.

| Token | Size | Weight | Usage |
|-------|------|--------|-------|
| `sizeXs` | 11px | — | Small labels, badges |
| `sizeSm` | 12px | — | Secondary text, captions |
| `sizeMd` | 13px | — | Settings rows, secondary content |
| `size` | 14px | — | Body text (default) |
| `sizeLg` | 15px | — | Primary content, inputs |
| `sizeXl` | 17px | 600 | Section headers, titles |
| `size2xl` | 20px | 600 | Screen titles, h1 |

### Font Families

- **System Font (UI):** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`
  - Used for all UI text, labels, and body content
  - Native system fonts for fast rendering and familiarity

- **Monospace:** `"SF Mono", ui-monospace, Menlo, Consolas, monospace`
  - Used for code blocks, tool names, technical data
  - Fallback to system monospace on non-Apple platforms

### Font Weights

- **Regular (400):** Body text, most content
- **Medium (500):** Buttons, secondary headings
- **Semibold (600):** Primary headings, important labels
- **Bold (700):** Rarely used; prefer semibold for hierarchy

### Line Heights

- **Normal (1.4):** Default for body text
- **Code (1.5):** Code blocks for better readability

## Spacing Scale

Consistent spacing creates visual rhythm and alignment. All spacing values are multiples of 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 4px | Tight spacing (badges, small gaps) |
| `sm` | 8px | Small gaps (icon spacing, chip padding) |
| `md` | 12px | Standard content padding, list gaps |
| `lg` | 16px | Section padding, major gaps |
| `xl` | 20px | Large margins, screen padding |
| `xxl` | 24px | Extra large section spacing |
| `xxxl` | 32px | Page-level padding, major dividers |

**Pattern:** Use `lg` (16px) as the default for horizontal padding on cards and screens. Use `md` (12px) for internal padding within components.

## Border Radius

Consistent rounding creates visual cohesion while respecting platform conventions.

| Token | Value | Usage |
|-------|-------|-------|
| `sm` | 4px | Small interactive elements (chip buttons) |
| `md` | 8px | Code blocks, text inputs |
| `lg` | 12px | Cards, settings sections |
| `xl` | 14px | Message bubbles, primary cards |
| `full` | 999px | Circular elements, pills |

## Component Styling Patterns

### Message Bubbles

**Agent messages:**
- Background: `colors.surface`
- Border: 1px `colors.border`
- Padding: 12px horizontal, 10px vertical
- Border radius: `radius.xl` (14px)
- Avatar: 28px circle, shown once per message group
- Text color: `colors.text`

**User messages:**
- Background: `colors.accent`
- Padding: 10px horizontal, 8px vertical
- Border radius: 12px
- Text color: white
- Right-aligned with max-width 85%

**Plain text messages:**
- No background
- Just text color `colors.text`
- No padding or border

**Messages with tool calls:**
- Same as agent messages + tool badge
- Badge background: `colors.toolDim`
- Badge text: `colors.tool`
- Badge text size: `sizeSm` (12px)

### Tool Call Badges

- Background: `colors.toolDim`
- Text color: `colors.tool`
- Padding: 4px 9px
- Border radius: 999px (pill shape)
- Font size: 11.5px
- Font weight: 500

Clickable to expand details in a bottom sheet.

### Settings Cards

- Background: `colors.surface`
- Border: 1px `colors.border`
- Border radius: `radius.lg` (12px)
- Margin: 8px horizontal
- Overflow: hidden (for rounded corners on dividers)

**Sections within cards:**
- Padding: 12px horizontal, 12px vertical
- Border between items: 1px `colors.border`
- Last item: no bottom border

### Section Labels

- Color: `colors.textDim`
- Font size: 11px (sizeXs)
- Font weight: 600 (semibold)
- Text transform: uppercase
- Letter spacing: 0.06em
- Padding: 16px horizontal, 16px top, 8px bottom
- Usage: "APPEARANCE", "CONNECTION", "DATA"

### Interactive Elements (Buttons, Pressables)

**Primary buttons:**
- Background: `colors.accent`
- Text: white
- Padding: 6px 14px
- Border radius: 6px
- Font size: 12.5px
- Font weight: 500

**Ghost/Secondary buttons:**
- Background: transparent
- Border: 1px `colors.border`
- Text: `colors.textMuted`
- Padding: 6px 12px
- Border radius: 6px
- Font size: 12px

**Icon buttons:**
- Size: 32px × 32px
- Border radius: 50% (circular)
- No border, no background (transparent)
- Hover: background `colors.surface2`

**Destructive buttons:**
- Text: `colors.danger`
- No background (unless hover)
- Hover: background `colors.surface2`

### Segmented Control (Theme Toggle, etc.)

- Background: `colors.surface2`
- Padding: 3px (gap between segments)
- Border radius: 6px
- Individual segments:
  - Padding: 5px 10px
  - Border radius: 4px
  - Inactive: transparent, text `colors.textMuted`
  - Active: background `colors.accent`, text white, font-weight 600

### Status Indicators

**Pulse animation (working/waiting):**
- Dot size: 7px × 7px
- Color: `colors.warn` (for default), `colors.accent` (for "waiting")
- Animation: pulse keyframe with box-shadow expansion
- Duration: 1.6s infinite

**Online indicator (small dot on avatar):**
- Size: 12px × 12px
- Color: `colors.success` (online) or `colors.textDim` (idle)
- Position: bottom-right of avatar with 2px border offset
- Border: 2.5px solid `colors.bg`

## Media and Attachments

**Audio/media attachment card:**
- Background: `colors.surface2`
- Border: 1px `colors.border`
- Padding: 10px 12px
- Border radius: 10px
- Play button: 32px circle with `colors.accent` background
- Text: `colors.text` for name, `colors.textMuted` for metadata

## Code Highlighting

Code blocks use syntax highlighting with theme-aware token colors.

### Dark Theme Token Colors (Atom One Dark inspired)

- Keywords: `#ff6b6b` (red)
- Built-ins: `#61afef` (blue)
- Strings: `#98c379` (green)
- Numbers: `#d19a66` (orange)
- Functions: `#c678dd` (purple)
- Comments: `#6a737d` (gray)

### Light Theme Token Colors (GitHub Light Colorblind)

- Keywords: `#cf222e` (red)
- Built-ins: `#0550ae` (blue)
- Strings: `#0a3069` (dark blue)
- Numbers: `#0550ae` (blue)
- Functions: `#6639ba` (purple)
- Comments: `#6e7781` (gray)

## Spacing Examples

### Card Layout
```typescript
{
  backgroundColor: colors.surface,
  marginHorizontal: spacing.lg,     // 16px padding on sides
  borderRadius: radius.lg,
  borderWidth: 1,
  borderColor: colors.border,
  overflow: 'hidden',
}

// Inside card:
{
  paddingHorizontal: spacing.lg,    // 16px
  paddingVertical: spacing.md,      // 12px
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
}
```

### Scrollable Content
```typescript
{
  paddingHorizontal: spacing.lg,    // 16px
  paddingTop: spacing.xl,           // 20px
  paddingBottom: spacing.xxl,       // 24px
  gap: spacing.md,                  // 12px between items
}
```

### Message Padding
```typescript
// Message body (agent)
{
  paddingHorizontal: spacing.md,    // 12px
  paddingVertical: spacing.sm,      // 8px
  borderRadius: radius.xl,          // 14px
}

// Messages container
{
  paddingHorizontal: spacing.md,    // 12px
  paddingTop: spacing.md,           // 12px
  paddingBottom: spacing.sm,        // 8px
  gap: spacing.md,                  // 12px between messages
}
```

## Best Practices

### 1. Always Use Design Tokens
Never hardcode colors or spacing. Always reference `theme.ts` values through the `useTheme()` hook.

```typescript
// ❌ Bad
<Text style={{ color: '#e6edf3', fontSize: 15 }}>Text</Text>

// ✅ Good
<Text style={{ color: colors.text, fontSize: typography.sizeLg }}>Text</Text>
```

### 2. Use makeStyles() Pattern
Create styles with `useMemo()` and the current colors to ensure theme changes are reactive.

```typescript
const styles = useMemo(() => makeStyles(colors), [colors])
```

### 3. Responsive Values
Base sizes are designed for mobile (375px width). Scale proportionally for larger screens if needed.

### 4. Accessibility
- Text contrast ratios meet WCAG AA standards (4.5:1 for body text)
- Interactive elements are at least 44px × 44px tap targets
- Color is not the only indicator (pair with icons or text)

### 5. Message Grouping
Group consecutive messages from the same sender:
- Show avatar only once per group
- Show timestamp only on the first message
- Visually separate with subtle borders

### 6. Semantic Colors
- **Accent:** Links, highlights, primary actions
- **Success:** Checkmarks, positive states
- **Warn:** Attention needed, caution states
- **Danger:** Destructive actions, errors
- **Tool:** AI/agent tool execution badges

### 7. Typography Hierarchy
Use size and weight to create clear hierarchy:
- Screen titles: `size2xl`, weight 600
- Section headers: `sizeXl`, weight 600
- Content: `sizeLg` or `size`, weight 400
- Labels/captions: `sizeSm` or `sizeXs`, weight 500-600

## Theme Switching

The theme preference is stored in SQLite and persists across sessions. Users can choose:
- **Auto:** Follow system dark/light preference (default)
- **Light:** Always use light theme
- **Dark:** Always use dark theme

The UI automatically re-renders when the theme changes thanks to React's `useMemo()` dependency on the `colors` object.

## Migration Guide: Adding New Components

When adding a new component:

1. **Accept `colors` as a parameter** or extract via `useTheme()`
2. **Create a `makeStyles()` function** that returns `StyleSheet.create()`
3. **Reference all colors from the `colors` object** passed to `makeStyles()`
4. **Use spacing scale** for padding, margins, and gaps
5. **Use radius scale** for all border radius values
6. **Test in both themes** to ensure adequate contrast and clarity

Example:

```typescript
import { useMemo } from 'react'
import { useTheme, type ThemeColors } from '../context/ThemeContext'
import { spacing, radius } from '../constants/theme'

export function NewComponent() {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Themed Component</Text>
    </View>
  )
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.surface,
      padding: spacing.lg,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    heading: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
  })
}
```

---

**Last updated:** June 2026  
**Related:** [Theme constants](../constants/theme.ts), [Theme context](../context/ThemeContext.tsx)
