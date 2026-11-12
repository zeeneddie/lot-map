export type StationId =
  | 'you' | 'model' | 'memory' | 'files' | 'shell'
  | 'web' | 'browser' | 'agents' | 'skills' | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

/** One action on the map. Labels carry names and record numbers, never the text of a memory. */
export type Entry = {
  id: string
  station: StationId
  label: string
  /** Where the pulse starts: the core, the agents station, or the station itself (a signal coming in). */
  from: 'core' | 'agents' | 'inbound'
  startedAt: number
  endedAt?: number
  status: Status
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId?: string
  /** The background task the call started; the row stays open until that task reports back. */
  task?: string
  /** A moment the map marks: the model changed, or the answer is ready. */
  mark?: 'switch' | 'done'
  /** What the call used, for the loaded column to light up: `skill:x`, `agent:x`, `file:a/b`, `mcp:x`. */
  ref?: string
  /** For a skill, agent or workflow: what the model wrote and thought just before it called it. */
  why?: string
}

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  model?: string
  step?: number
  /** How many of the memory station's count a hook brought unasked. */
  pushed?: number
  /** Errors and refusals per station since the person's last message. */
  faults?: Partial<Record<StationId, number>>
  /** Subagents whose loops are still going. */
  agents?: string[]
  /** How full the context window is, 0 to 100. */
  context?: number
  /** When the model last changed. */
  switchedAt?: number
  /** How much thinking and visible text came through the model's stream this session (characters), and in how many steps. */
  seen?: { thinking: number; text: number; steps: number }
}

/** One name in the loaded column, with where it comes from. */
export type Item = { name: string; source: string }

/** What the session has loaded: read from the engine's own lists, never from a model. */
export type Catalog = {
  tools: number
  /** Tools per MCP server. */
  mcp: Record<string, number>
  commands: Item[]
  agents: Item[]
  /** Instruction and memory files the session read (last two parts of the path). */
  files: string[]
  /** What the configuration on disk says should be there: names only, never values. */
  config?: Config
  /** Instruction files the engine itself loaded (InstructionsLoaded): why, and which file brought them in. */
  loaded?: LoadedFile[]
  /** Files read from a skill's own folder, by skill: what a skill made the session read. */
  chain?: Record<string, string[]>
}

export type LoadedFile = { file: string; kind: string; reason: string; parent?: string }

/** A hook as the settings declare it, and whether the script it runs is there. */
export type HookDecl = { event: string; matcher: string; script: string; missing: boolean }

export type Config = {
  mcp: string[]
  agents: string[]
  skills: string[]
  hooks: HookDecl[]
  /** Instruction and memory files that exist (last two parts of the path). */
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'lot-map': { board: Shaped<Board>; catalog: Shaped<Catalog> }
  }
}
