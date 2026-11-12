import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Catalog, Config, Entry, StationId, Status } from '../types'
import type { Source } from './catalog'
import { ASK_WHY, EMPTY_CATALOG, mcpStatusOf, WHY_TOOLS, mentions, splitClaudeMd, statedWhy, whyOf, skillFileOf, activeRefs, columnLines, frontName, fromCommands, fromTools, hookDecls, instructionPaths, lastTwo, mcpNames, refOf, sameCatalog, steeringFile } from './catalog'
import { STATIONS, classify, clean, describeNow, drawMap, firstLine, foldRows, formatMs, memoryIds, setupFrom, shortModel, taskNotice, taskOf } from './map'
import type { Setup } from './map'

const PANE = 'lot-map'
const KEEP = 80
const CREW = 12

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'lot-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-5' })

// What the session has loaded, for the column beside the feed. Read from the engine's lists alone.
const catalog = atom({ plugin: 'lot-map', key: 'catalog' } as const, EMPTY_CATALOG as Catalog, { shape: 'catalog-1' })

/** Below this many columns the two parts of the pane stack instead of standing side by side. */
const SIDE_BY_SIDE = 100
const LEFT = 48

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  ref?: string
  why?: string
  source?: string
  useId?: string
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

/** The newest rows, and beside them every background task still going, however long ago it started. */
const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: newId(now),
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt ?? now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
      ...(start.ref !== undefined ? { ref: start.ref } : {}),
      ...(start.why !== undefined ? { why: start.why } : {}),
      ...(start.source !== undefined ? { source: start.source } : {}),
      ...(start.useId !== undefined ? { useId: start.useId } : {}),
    }
    await update($, board, b => ({
      ...b,
      ...start.patch,
      entries: kept([...b.entries, entry]),
      counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      // An interrupted turn lands on the person's own station and is no fault of anything.
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
        ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
        : {}),
    }))
    return entry.id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const open = b.entries.find(e => e.id === id && e.status === 'run')
      return {
        ...b,
        ...patch,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(open !== undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** The call started work that goes on after it answered: its row stays open under the task's id. */
async function background($: EngineInterface, id: string | undefined, task: string): Promise<void> {
  if (id === undefined) return
  await quietly(() => update($, board, b => ({ ...b, entries: b.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)) })))
}

/** A background task ended: its row closes, as a fault when the task failed. */
async function settle($: EngineInterface, task: string, status: Status): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const open = b.entries.find(e => e.task === task && e.status === 'run')
      if (open === undefined) return b
      return {
        ...b,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** Reads the engine's lists of tools and commands again; draws again only when they changed. */
async function refresh($: EngineInterface): Promise<void> {
  await quietly(async () => {
    const tools = await $.tool.list()
    const commands = await $.command.list()
    await update($, catalog, c => {
      const next = { ...c, ...fromTools(tools), commands: fromCommands(commands) }
      return sameCatalog(c, next) ? c : next
    })
  })
}

/** A file's text, or undefined when it is not there or cannot be read. */
const textOf = async ($: EngineInterface, path: string): Promise<string | undefined> => quietly(() => $.fs.read(path) as Promise<string>)

const jsonOf = async ($: EngineInterface, path: string): Promise<unknown> => {
  const text = await textOf($, path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Markdown files in a folder and the folders in it, one level down: agent definitions are kept that way. */
async function markdownIn($: EngineInterface, dir: string): Promise<string[]> {
  const out: string[] = []
  const top = (await quietly(() => $.fs.list(dir))) ?? []
  for (const e of top) {
    if (e.kind === 'file' && e.name.endsWith('.md')) out.push(`${dir}/${e.name}`)
    if (e.kind === 'dir') for (const s of (await quietly(() => $.fs.list(`${dir}/${e.name}`))) ?? []) if (s.kind === 'file' && s.name.endsWith('.md')) out.push(`${dir}/${e.name}/${s.name}`)
  }
  return out
}

/**
 * What the configuration on disk says should be there, for the session in `cwd`: names only. The values in it
 * (an MCP server's command, its environment, a hook's arguments) are read past and never kept.
 */
async function readConfig($: EngineInterface, cwd: string): Promise<Config | undefined> {
  return quietly(async () => {
    const home = (await $.env.get('HOME')) ?? ''
    const mcp = mcpNames(await jsonOf($, `${home}/.claude.json`), await jsonOf($, `${cwd}/.mcp.json`), cwd)
    const agents: string[] = []
    for (const path of [...(await markdownIn($, `${home}/.claude/agents`)), ...(await markdownIn($, `${cwd}/.claude/agents`))]) {
      const text = await textOf($, path)
      agents.push((text !== undefined ? frontName(text) : undefined) ?? (path.split('/').pop() ?? '').replace(/\.md$/, ''))
    }
    const skills: string[] = []
    for (const dir of [`${home}/.claude/skills`, `${cwd}/.claude/skills`]) {
      for (const e of (await quietly(() => $.fs.list(dir))) ?? []) {
        if (e.kind !== 'dir' && !e.isLink) continue
        const text = await textOf($, `${dir}/${e.name}/SKILL.md`)
        if (text !== undefined) skills.push(frontName(text) ?? e.name)
      }
    }
    const settings = (await quietly(() => $.settings.read() as Promise<Record<string, unknown>>)) ?? {}
    const hooks = []
    for (const h of hookDecls(settings.hooks, home, cwd)) {
      const there = h.path === undefined ? true : ((await quietly(() => $.fs.exists(h.path as string))) ?? true)
      hooks.push({ event: h.event, matcher: h.matcher, script: h.script, missing: !there })
    }
    const files: string[] = []
    for (const path of instructionPaths(home, cwd)) if (await quietly(() => $.fs.exists(path))) files.push(lastTwo(path))
    return { mcp, agents: [...new Set(agents)], skills: [...new Set(skills)], hooks, files }
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  const { t } = setup
  // The feed's second column fits the longest station name of the language.
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))

  // Calls a settings hook refused, so that the tool's own row reads as blocked and not as an error.
  // Loses nothing across a reload that matters: a reload never lands in the middle of a call.
  const refused = new Set<string>()

  // What the model wrote and thought just before a skill, agent or workflow call, by the call's tool_use_id,
  // until tool.call picks it up. Read from the stream of turn.step, which is handed on chunk for chunk.
  const reasons = new Map<string, string>()
  // The same by tool name, for a call whose tool.call carries no tool_use_id: the latest reason per tool.
  const reasonsByTool = new Map<string, string>()

  // What the model had in front of it, to find where a skill's or agent's name stood (why, source 1). Kept in the
  // module only, never in state: the system prompt and the instruction files are large, and only names are looked up.
  const askWhyOption = (options as Record<string, unknown> | undefined)?.askWhy
  const askWhy = askWhyOption === true || askWhyOption === 'true'
  let lastPrompt = ''
  let systemSections: Source[] = []
  let contextSources: Source[] = []
  const attachments = new Map<string, string>()
  const sourcesNow = (): Source[] => [
    ...(lastPrompt ? [{ label: 'jouw prompt', text: lastPrompt }] : []),
    ...contextSources,
    ...[...attachments].map(([type, text]) => ({ label: `herinnering ${type}`, text })),
    ...systemSections,
  ]

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'lot-map', description: t.command }))
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    await refresh($)
    const config = await readConfig($, e.cwd)
    if (config !== undefined) await quietly(() => update($, catalog, c => ({ ...c, config })))
    return next(e)
  })

  // An instruction file the engine loaded itself: which, of what kind, why, and from which file. Handed on unchanged.
  on('classic.InstructionsLoaded', async ($, e, next) => {
    await quietly(async () => {
      const file = lastTwo(e.file_path)
      const entry = { file, kind: e.memory_type, reason: e.load_reason, ...(e.parent_file_path ? { parent: lastTwo(e.parent_file_path) } : {}) }
      await update($, catalog, c => ((c.loaded ?? []).some(l => l.file === file) ? c : { ...c, loaded: [...(c.loaded ?? []), entry].slice(-40) }))
    })
    return next(e)
  })

  // The system prompt as composed: kept to look names up in, and with askWhy one line added at the end asking the
  // model to say why before it calls a skill, an agent or a workflow.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    await quietly(async () => {
      systemSections = composed.sections.map(s => ({ label: `systeemprompt ${s.id}`, text: s.text }))
    })
    if (!askWhy) return composed
    return { sections: [...composed.sections, { id: 'lot-map:waarom', text: ASK_WHY, scope: 'session' as const }] }
  })

  // The context of the first message: the instruction files and memory, each under its own name.
  on('prompt.context', async ($, e, next) => {
    const ctx = await next(e)
    await quietly(async () => {
      contextSources = ctx.blocks.flatMap(b => (b.name === 'claudeMd' ? splitClaudeMd(b.text) : [{ label: b.name, text: b.text }]))
      const files = contextSources.filter(s => s.label.endsWith('.md')).map(s => s.label)
      await update($, catalog, c => (JSON.stringify(c.context) === JSON.stringify(files) ? c : { ...c, context: files }))
    })
    return ctx
  })

  // Reminders the engine adds (among them the list of skills with their descriptions): kept by type, latest wins.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    await quietly(async () => {
      const type = (e as { type?: unknown }).type
      if (typeof type === 'string' && typeof r.text === 'string' && r.text) attachments.set(type, r.text)
      if (attachments.size > 30) attachments.delete(attachments.keys().next().value as string)
    })
    return r
  })

  // An agent type offered to the model: noted for the loaded column, and handed on exactly as it came.
  on('agent.offer', async ($, e, next) => {
    await quietly(() =>
      update($, catalog, c =>
        c.agents.some(a => a.name === e.agent) ? c : { ...c, agents: [...c.agents, { name: e.agent, source: e.source }] },
      ),
    )
    return next(e)
  })

  on('command.run', { command: 'lot-map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.cannotOpen(String(opened.reason)) }
  })

  on('turn.start', async ($, e, next) => {
    const notice = e.agentId === undefined ? taskNotice(e.text) : undefined
    if (notice !== undefined) {
      // A background task reporting back is no message of the person's.
      if (notice.status !== undefined) await settle($, notice.id, notice.status)
    } else if (e.agentId === undefined && e.text !== '') {
      lastPrompt = e.text
      await refresh($)
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    let thinking = ''
    let text = ''
    // Measured per step: which chunk kinds and which tool names come through, and how many reasons were kept.
    const kinds: Record<string, number> = {}
    const tools: Record<string, number> = {}
    let kept = 0
    try {
      const stream = next(e)
      let item = await stream.next()
      while (item.done !== true) {
        const c = item.value as { kind?: string; text?: unknown; name?: unknown; id?: unknown }
        if (typeof c.kind === 'string') kinds[c.kind] = (kinds[c.kind] ?? 0) + 1
        if (c.kind === 'tool' && typeof c.name === 'string') tools[c.name] = (tools[c.name] ?? 0) + 1
        if (c.kind === 'thinking' && typeof c.text === 'string') thinking += c.text
        else if (c.kind === 'text' && typeof c.text === 'string') text += c.text
        else if (c.kind === 'tool' && typeof c.id === 'string' && typeof c.name === 'string' && WHY_TOOLS.has(c.name)) {
          const stated = statedWhy(text)
          const why = stated !== undefined ? `Waarom: ${stated}` : whyOf(thinking, text)
          if (why !== undefined) {
            kept++
            reasons.set(c.id, why)
            reasonsByTool.set(c.name, why)
            // The engine may have started the call already: then its row exists and takes the reason now.
            const useId = c.id
            await quietly(() =>
              update($, board, b =>
                b.entries.some(x => x.useId === useId && x.why === undefined)
                  ? { ...b, entries: b.entries.map(x => (x.useId === useId && x.why === undefined ? { ...x, why } : x)) }
                  : b,
              ),
            )
          }
          if (reasons.size > 50) reasons.delete(reasons.keys().next().value as string)
        }
        yield item.value
        item = await stream.next()
      }
      return item.value
    } finally {
      await quietly(() =>
        update($, board, b => ({
          ...b,
          seen: {
            thinking: (b.seen?.thinking ?? 0) + thinking.length,
            text: (b.seen?.text ?? 0) + text.length,
            steps: (b.seen?.steps ?? 0) + 1,
            tools: Object.entries(tools).reduce((acc, [k, n]) => ({ ...acc, [k]: (acc[k] ?? 0) + n }), { ...b.seen?.tools }),
            kinds: Object.entries(kinds).reduce((acc, [k, n]) => ({ ...acc, [k]: (acc[k] ?? 0) + n }), { ...b.seen?.kinds }),
            reasons: (b.seen?.reasons ?? 0) + kept,
          },
        })),
      )
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled.
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          agents: (b.agents ?? []).filter(id => id !== agentId),
          entries: b.entries.map(x => (x.status === 'run' && (x.agentId === agentId || x.task === agentId) ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      // The engine's lists may still be empty at session.start: the first call reads them again.
      if ((await read($, catalog)).tools === 0) await refresh($)
      const input = e as unknown as Record<string, unknown>
      const seen = classify(e.tool, input, setup)
      const ref = refOf(e.tool, input)
      const file = steeringFile(e.tool, input)
      if (file !== undefined) {
        await update($, catalog, c => (c.files.includes(file) ? c : { ...c, files: [...c.files, file].slice(-24) }))
      }
      const fromSkill = e.tool === 'Read' && typeof input.file_path === 'string' ? skillFileOf(input.file_path) : undefined
      if (fromSkill !== undefined) {
        await update($, catalog, c => {
          const had = c.chain?.[fromSkill.skill] ?? []
          return had.includes(fromSkill.file) ? c : { ...c, chain: { ...c.chain, [fromSkill.skill]: [...had, fromSkill.file].slice(-12) } }
        })
      }
      const byId = e.tool_use_id !== undefined ? reasons.get(e.tool_use_id) : undefined
      const why = byId ?? reasonsByTool.get(e.tool)
      if (e.tool_use_id !== undefined) reasons.delete(e.tool_use_id)
      reasonsByTool.delete(e.tool)
      const named = e.tool === 'Skill' ? input.skill : e.tool === 'Agent' ? input.subagent_type || 'general-purpose' : undefined
      const found = typeof named === 'string' ? mentions(named, sourcesNow(), 2, 70) : []
      const source = found.length ? found.join(' · ') : typeof named === 'string' ? 'nergens genoemd: eigen keuze van het model' : undefined
      return begin($, { ...seen, ...(ref !== undefined ? { ref } : {}), ...(why !== undefined ? { why } : {}), ...(source !== undefined ? { source } : {}), ...(e.tool_use_id !== undefined ? { useId: e.tool_use_id } : {}), ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    })
    try {
      const ran = await next(e)
      // A ToolSearch result names the MCP servers that failed or are still connecting: read along, nothing asked.
      if (e.tool === 'ToolSearch') {
        const status = mcpStatusOf(ran.result)
        if (status !== undefined) await quietly(() => update($, catalog, c => ({ ...c, mcpStatus: status })))
      }
      const wasRefused = ran.deny !== undefined || (e.tool_use_id !== undefined && refused.delete(e.tool_use_id))
      const task = wasRefused || ran.isError === true ? undefined : taskOf(ran.result)
      if (task !== undefined) {
        await background($, id, task)
        return ran
      }
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = (await quietly(() => $.clock.now())) ?? 0
    const decided = await next(e)
    const endedAt = (await quietly(() => $.clock.now())) ?? startedAt
    if (decided.deny !== undefined) {
      if (e.tool_use_id !== undefined) refused.add(e.tool_use_id)
      await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(decided.deny) : '') || t.stopped(e.tool), status: 'block', startedAt, ref: `hook:PreToolUse:${e.tool}` })
    } else if (decided.ask !== undefined) {
      await begin($, { station: 'hooks', label: t.askedPermission(e.tool), status: 'ok', startedAt, endedAt, ref: `hook:PreToolUse:${e.tool}` })
    } else if (endedAt - startedAt >= 400) {
      // A check that took a moment is worth seeing; the instant ones are not.
      await begin($, { station: 'hooks', label: t.checkBefore(e.tool), status: 'ok', startedAt, endedAt, ref: `hook:PreToolUse:${e.tool}` })
    }
    return decided
  })

  // A notification delivered into a running turn starts no turn of its own; this is where it is seen.
  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => {
      if (e.origin?.kind !== 'task-notification') return
      const notice = taskNotice(e.text)
      if (notice?.status !== undefined) await settle($, notice.id, notice.status)
    })
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await update($, board, b => {
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === e.skill)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label: e.skill, from: 'core', startedAt: now, endedAt: now, status: 'ok', ref: `skill:${e.skill}` }
        return { ...b, entries: [...b.entries, entry].slice(-KEEP), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const rows = foldRows(state.entries).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const line = `${mark} ${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}${took === '' ? '' : `  ${took}`}`
      const row = (
        <Text mono size="footnote" color={color} dimColor={entry.status === 'ok' && !isSwitch}>
          {line}
        </Text>
      )
      if (entry.why === undefined && entry.source === undefined) return row
      return (
        <Box flexDirection="column">
          {row}
          {entry.why !== undefined ? (
            <Text mono size="footnote" dimColor>
              {`  ↳ waarom (eigen woorden model): ${entry.why}`}
            </Text>
          ) : null}
          {entry.source !== undefined ? (
            <Text mono size="footnote" dimColor>
              {`  ↳ genoemd in: ${entry.source}`}
            </Text>
          ) : null}
        </Box>
      )
    })
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>

    const loaded = await read($, catalog)
    const bodyCols = e.props?.bodyColumns ?? 80
    const bodyRows = e.props?.scroll?.bodyRows ?? 40
    const beside = bodyCols >= SIDE_BY_SIDE
    const lines = columnLines(loaded, activeRefs(state.entries), beside ? LEFT - 2 : bodyCols - 2, beside ? bodyRows : Math.floor(bodyRows / 2))
    const side = (
      <Box flexDirection="column" width={beside ? LEFT : undefined}>
        {lines.map(l => (
          <Text mono size="footnote" bold={l.head === true} color={l.lit ? 'claude' : l.warn ? 'warning' : undefined} dimColor={l.dim === true}>
            {l.text === '' ? ' ' : l.text}
          </Text>
        ))}
      </Box>
    )
    const both = (work: typeof feed) => (
      <Box flexDirection={beside ? 'row' : 'column'} gap={1}>
        {side}
        <Box flexDirection="column" flexGrow={1}>
          {work}
        </Box>
      </Box>
    )

    if (e.surface === 'terminal') {
      const tally = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${state.counts[s.id]}`).join(' · ')
      return (
        <Box flexDirection="column">
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {state.seen !== undefined ? (
            <Text dimColor>{`Stroom: denken ${state.seen.thinking} · tekst ${state.seen.text} tekens in ${state.seen.steps} stappen · redenen ${state.seen.reasons ?? 0}`}</Text>
          ) : null}
          {state.seen !== undefined ? (
            <Text dimColor>{`  chunks ${Object.entries(state.seen.kinds ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'} · tools ${Object.entries(state.seen.tools ?? {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`}</Text>
          ) : null}
          {both(feed)}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Svg source={drawMap(state, now, setup)} alt={`${t.title}. ${describeNow(state, t)}`} />
        {current}
        {both(feed)}
      </Box>
    )
  })
}
