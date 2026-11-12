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

/** One line of the column: the name, lit when in use, a warning when configured but not there. */
export type Line = { text: string; lit: boolean; head?: boolean; dim?: boolean; warn?: boolean }

const count = (items: readonly Item[]): string => {
  const by = new Map<string, number>()
  for (const i of items) {
    if (i.source === '') continue
    const kind = i.source.startsWith('plugin') ? 'plugin' : i.source
    by.set(kind, (by.get(kind) ?? 0) + 1)
  }
  return [...by].map(([k, n]) => `${k} ${n}`).join(' · ')
}

/** An MCP server's name as tool names spell it: `claude.ai Gmail` is `claude_ai_Gmail`. */
export const toolSpelling = (server: string): string => server.replace(/[^A-Za-z0-9_-]/g, '_')

/** What is configured and not loaded. Before the first model call the lists are not complete yet, so nothing is missing. */
export function missing(catalog: Catalog): { mcp: string[]; agents: string[]; skills: string[] } {
  const cfg = catalog.config
  const started = catalog.agents.length > 0
  if (cfg === undefined || !started) return { mcp: [], agents: [], skills: [] }
  const servers = new Set(Object.keys(catalog.mcp))
  const agents = new Set(catalog.agents.map(a => a.name))
  const commands = new Set(catalog.commands.map(c => c.name))
  return {
    mcp: cfg.mcp.filter(s => !servers.has(toolSpelling(s))),
    agents: cfg.agents.filter(a => !agents.has(a)),
    skills: cfg.skills.filter(s => !commands.has(s)),
  }
}

/**
 * The column as lines, fitted to `width` and `rows`. In each part: what is in use first, then what is configured
 * and not there, then the rest, so neither is ever cut off. Built-in commands are counted and not named.
 */
export function columnLines(catalog: Catalog, lit: Set<string>, width: number, rows: number): Line[] {
  const max = Math.max(8, width)
  // Names and sources are cleaned one by one; the line keeps its own marker and spacing, cut to the column.
  const cut = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const fit = (s: string): string => cut(clean(s, max))
  const item = (mark: string, name: string, source: string): string =>
    cut(`${mark} ${clean(name, max)}${source ? ` · ${clean(source, 40)}` : ''}`)
  const gone = missing(catalog)
  const lines: Line[] = []
  const servers = Object.entries(catalog.mcp)
  lines.push({ text: 'GELADEN', lit: false, head: true })
  lines.push({ text: fit(`Tools ${catalog.tools}${servers.length ? ` · MCP ${servers.reduce((n, [, c]) => n + c, 0)}` : ''}`), lit: false })
  for (const [server, n] of servers) {
    const on = lit.has(`mcp:${server}`)
    lines.push({ text: item(on ? '▶' : ' ', server, String(n)), lit: on, dim: !on })
  }
  for (const server of gone.mcp) lines.push({ text: item('✕', server, 'geconfigureerd, niet geladen'), lit: false, warn: true })

  const part = (title: string, items: readonly Item[], key: (i: Item) => string, show: (i: Item) => boolean, room: number, absent: readonly string[] = [], why = ''): void => {
    lines.push({ text: '', lit: false })
    lines.push({ text: fit(title), lit: false, head: true })
    const kinds = count(items)
    if (kinds !== '') lines.push({ text: fit(`${kinds}${absent.length ? ` · ✕ ${absent.length}` : ''}`), lit: false, dim: true })
    if (items.length === 0 && absent.length === 0) {
      lines.push({ text: '  nog niets', lit: false, dim: true })
      return
    }
    const on = items.filter(i => lit.has(key(i)))
    for (const i of on) lines.push({ text: item('▶', i.name, i.source), lit: true })
    const left = Math.max(0, room - on.length)
    const warn = absent.slice(0, Math.max(2, Math.ceil(left / 2)))
    for (const name of warn) lines.push({ text: item('✕', name, why), lit: false, warn: true })
    const rest = items.filter(i => !lit.has(key(i)) && show(i))
    const shown = rest.slice(0, Math.max(0, left - warn.length))
    for (const i of shown) lines.push({ text: item(' ', i.name, i.source), lit: false, dim: true })
    const hidden = rest.length - shown.length + absent.length - warn.length
    if (hidden > 0) lines.push({ text: `  +${hidden}`, lit: false, dim: true })
  }

  const room = Math.max(3, Math.floor((rows - lines.length - 14) / 4))
  part('Skills / commando’s', catalog.commands, i => `skill:${i.name}`, i => i.source !== 'builtin', room, gone.skills, 'map, niet in lijst')
  part('Agents', catalog.agents, i => `agent:${i.name}`, () => true, room, gone.agents, 'bestand, niet aangeboden')

  // Instruction files: every one that exists, and every one the session read; marked by whether it was read.
  const cfgFiles = catalog.config?.files ?? []
  const all = [...new Set([...cfgFiles, ...catalog.files])]
  lines.push({ text: '', lit: false })
  lines.push({ text: 'Instructies', lit: false, head: true })
  if (all.length === 0) lines.push({ text: '  nog niets', lit: false, dim: true })
  for (const name of all.slice(0, Math.max(room, 4))) {
    const on = lit.has(`file:${name}`)
    const read = catalog.files.includes(name)
    lines.push({ text: item(on ? '▶' : read ? '✓' : ' ', name, read ? 'gelezen' : 'niet gelezen'), lit: on, dim: !on && read })
  }

  // Hooks as the settings declare them: the script each runs, and whether it is there.
  const hooks = catalog.config?.hooks ?? []
  if (hooks.length > 0) {
    lines.push({ text: '', lit: false })
    lines.push({ text: fit(`Hooks (settings) ${hooks.length}`), lit: false, head: true })
    const sorted = [...hooks].sort((a, b) => Number(b.missing) - Number(a.missing))
    for (const h of sorted.slice(0, Math.max(room, 4))) {
      lines.push({ text: item(h.missing ? '✕' : ' ', `${h.event}${h.matcher ? ` ${h.matcher}` : ''}`, h.missing ? `${h.script} ontbreekt` : h.script), lit: false, warn: h.missing, dim: !h.missing })
    }
    if (hooks.length > Math.max(room, 4)) lines.push({ text: `  +${hooks.length - Math.max(room, 4)}`, lit: false, dim: true })
  }
  return lines
}

// ---- reading the configuration (names only) -------------------------------------------------------------------

/** The `name:` in a markdown file's front matter, or undefined. */
export function frontName(text: string): string | undefined {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  const name = m?.[1] !== undefined ? /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(m[1])?.[1] : undefined
  return name?.trim() || undefined
}

/** MCP server names from a parsed `~/.claude.json` (top level and this folder's project) and a parsed `.mcp.json`. Names only. */
export function mcpNames(claudeJson: unknown, mcpJson: unknown, cwd: string): string[] {
  const keys = (o: unknown): string[] => (o !== null && typeof o === 'object' ? Object.keys(o as object) : [])
  const cj = (claudeJson ?? {}) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }
  const mj = (mcpJson ?? {}) as { mcpServers?: unknown }
  return [...new Set([...keys(cj.mcpServers), ...keys(cj.projects?.[cwd]?.mcpServers), ...keys(mj.mcpServers)])]
}

/** The script a hook command runs: the first word that is a path, with `~`, `$HOME` and `$CLAUDE_PROJECT_DIR` written out. */
export function scriptOf(command: string, home: string, cwd: string): string | undefined {
  const words = command.replace(/\$\{?HOME\}?/g, home).replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, cwd).split(/\s+/)
  const path = words.map(w => w.replace(/^["']|["']$/g, '')).find(w => w.includes('/') && !w.startsWith('-') && !w.includes('$'))
  return path?.replace(/^~(?=\/)/, home)
}

/** The hooks in merged settings, each with its script; `exists` tells whether the script is there. */
export function hookDecls(hooks: unknown, home: string, cwd: string): { event: string; matcher: string; script: string; path: string | undefined }[] {
  const out: { event: string; matcher: string; script: string; path: string | undefined }[] = []
  if (hooks === null || typeof hooks !== 'object') return out
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups as { matcher?: unknown; hooks?: unknown }[]) {
      const matcher = typeof g?.matcher === 'string' ? g.matcher : ''
      for (const h of Array.isArray(g?.hooks) ? (g.hooks as { command?: unknown }[]) : []) {
        if (typeof h?.command !== 'string') continue
        const path = scriptOf(h.command, home, cwd)
        out.push({ event, matcher, script: path ? lastTwo(path) : clean(h.command, 30), path })
      }
    }
  }
  return out
}

/** Where instruction and memory files may stand for a session in `cwd`. */
export function instructionPaths(home: string, cwd: string): string[] {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  return [`${home}/.claude/CLAUDE.md`, `${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`, `${cwd}/AGENTS.md`, `${home}/.claude/projects/${slug}/memory/MEMORY.md`]
}

export { lastTwo }

/** A catalog changed only when what it lists changed, so an unchanged refresh draws nothing again. */
export function sameCatalog(a: Catalog, b: Catalog): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
