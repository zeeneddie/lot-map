// The loaded column: what the session has at hand, and which of it the work in the feed is using.
// Everything here is read from the engine's own lists or from the calls the map already sees; no model is asked.
import type { Catalog, Entry, Item } from '../types'

import { clean } from './map'

export const EMPTY_CATALOG: Catalog = { tools: 0, mcp: {}, commands: [], agents: [], files: [] }

/** A path with Windows separators written as `/`. */
const slashes = (path: string): string => path.replace(/\\/g, '/')
const lastTwo = (path: string): string => slashes(path).split('/').filter(Boolean).slice(-2).join('/')
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Files that steer the work: instructions, memory and skill definitions. Reading one puts it in the column. */
const STEERING = /(^|\/)(CLAUDE\.md|AGENTS\.md|MEMORY\.md|SKILL\.md|PRINCIPES\.md)$|\/\.claude\/(agents|skills|commands)\/|\/memory\/[^/]+\.md$/

export function isSteering(path: string): boolean {
  return STEERING.test(slashes(path))
}

/** What a call uses, as the loaded column names it; undefined when it uses nothing listed there. */
export function refOf(tool: string, input: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'Skill':
      return str(input.skill) ? `skill:${str(input.skill)}` : undefined
    case 'Agent':
      return `agent:${str(input.subagent_type) || 'general-purpose'}`
    case 'Read':
    case 'Write':
    case 'Edit': {
      const path = str(input.file_path)
      return path && isSteering(path) ? `file:${lastTwo(path)}` : undefined
    }
  }
  const mcp = /^mcp__([^_].*?)__/.exec(tool)
  return mcp?.[1] ? `mcp:${mcp[1]}` : undefined
}

/** The file a call read, when it is one that steers the work. */
export function steeringFile(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== 'Read') return undefined
  const path = str(input.file_path)
  return path && isSteering(path) ? lastTwo(path) : undefined
}

/** The tools as the engine lists them: how many, and how many each MCP server brings. */
export function fromTools(tools: readonly { name: string; mcp: boolean }[]): Pick<Catalog, 'tools' | 'mcp'> {
  const mcp: Record<string, number> = {}
  for (const t of tools) {
    if (!t.mcp) continue
    const server = /^mcp__([^_].*?)__/.exec(t.name)?.[1] ?? '?'
    mcp[server] = (mcp[server] ?? 0) + 1
  }
  return { tools: tools.length, mcp }
}

export function fromCommands(commands: readonly { name: string; source: string; plugin?: string }[]): Item[] {
  return commands.map(c => ({ name: c.name, source: c.plugin ? `plugin ${c.plugin}` : c.source }))
}

/** The refs the feed is using now: every running call, and the last few that ended. */
export function activeRefs(entries: readonly Entry[], recent = 3): Set<string> {
  const refs = new Set<string>()
  let ended = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.ref === undefined) continue
    if (e.status === 'run') refs.add(e.ref)
    else if (ended < recent) {
      refs.add(e.ref)
      ended++
    }
  }
  return refs
}

/** One line of the column: the name, lit when in use. */
export type Line = { text: string; lit: boolean; head?: boolean; dim?: boolean }

const count = (items: readonly Item[]): string => {
  const by = new Map<string, number>()
  for (const i of items) {
    if (i.source === '') continue
    const kind = i.source.startsWith('plugin') ? 'plugin' : i.source
    by.set(kind, (by.get(kind) ?? 0) + 1)
  }
  return [...by].map(([k, n]) => `${k} ${n}`).join(' · ')
}

/**
 * The column as lines, fitted to `width` and `rows`. What is in use comes first in each part, so it is never cut off;
 * the built-in commands are counted and not named, they are the same in every session.
 */
export function columnLines(catalog: Catalog, lit: Set<string>, width: number, rows: number): Line[] {
  const max = Math.max(8, width)
  // Names and sources are cleaned one by one; the line keeps its own marker and spacing, cut to the column.
  const cut = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const fit = (s: string): string => cut(clean(s, max))
  const item = (on: boolean, name: string, source: string): string =>
    cut(`${on ? '▶' : ' '} ${clean(name, max)}${source ? ` · ${clean(source, 40)}` : ''}`)
  const lines: Line[] = []
  const servers = Object.entries(catalog.mcp)
  lines.push({ text: 'GELADEN', lit: false, head: true })
  lines.push({ text: fit(`Tools ${catalog.tools}${servers.length ? ` · MCP ${servers.reduce((n, [, c]) => n + c, 0)}` : ''}`), lit: false })
  for (const [server, n] of servers) {
    const on = lit.has(`mcp:${server}`)
    lines.push({ text: item(on, server, String(n)), lit: on, dim: !on })
  }

  const part = (title: string, items: readonly Item[], key: (i: Item) => string, show: (i: Item) => boolean, room: number): void => {
    lines.push({ text: '', lit: false })
    lines.push({ text: fit(title), lit: false, head: true })
    const kinds = count(items)
    if (kinds !== '') lines.push({ text: fit(kinds), lit: false, dim: true })
    if (items.length === 0) {
      lines.push({ text: '  nog niets', lit: false, dim: true })
      return
    }
    const on = items.filter(i => lit.has(key(i)))
    const rest = items.filter(i => !lit.has(key(i)) && show(i))
    const candidates = [...on, ...rest]
    const shown = candidates.slice(0, Math.max(on.length, room))
    for (const i of shown) {
      const isOn = lit.has(key(i))
      lines.push({ text: item(isOn, i.name, i.source), lit: isOn, dim: !isOn })
    }
    const hidden = candidates.length - shown.length
    if (hidden > 0) lines.push({ text: `  +${hidden}`, lit: false, dim: true })
  }

  const room = Math.max(3, Math.floor((rows - lines.length - 10) / 3))
  part('Skills / commando’s', catalog.commands, i => `skill:${i.name}`, i => i.source !== 'builtin', room)
  part('Agents', catalog.agents, i => `agent:${i.name}`, () => true, room)
  part('Gelezen instructies', catalog.files.map(f => ({ name: f, source: '' })), i => `file:${i.name}`, () => true, room)
  return lines
}

/** A catalog changed only when what it lists changed, so an unchanged refresh draws nothing again. */
export function sameCatalog(a: Catalog, b: Catalog): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
