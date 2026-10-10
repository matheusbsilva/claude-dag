import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DagFile, DagStatus } from '../types'

import { layout, visibleTree } from './layout'
import { emptyGraph } from './model'
import type { DagEvent } from './model'
import { drawPane } from './pane'
import { FILE_BUDGET, asIndex, parseGraph, serializeWithin, trimSlash, withEntry } from './persist'
import { mergeLive, rebuild } from './rebuild'
import type { ApiRow } from './rebuild'
import { reduce } from './reduce'
import { toSvg } from './svg'

const PANE = 'dag'
const TITLE = 'Conversation DAG'
const FLUSH_MS = 1000
const INDEX_KEY = 'sessions'

const graphAtom = atom({ plugin: 'dag', key: 'graph' } as const, null)
const selectedAtom = atom({ plugin: 'dag', key: 'selected' } as const, null)

type Options = {
  windowTurns: number
  maxDetailChars: number
  excludedTools: Set<string>
  exportDir: string
  dataDir: string
}

const readOptions = (options: Readonly<Record<string, unknown>>): Options => {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const list = Array.isArray(options.excludedTools) ? options.excludedTools : str(options.excludedTools).split(',')
  return {
    windowTurns: num(options.windowTurns, 10),
    maxDetailChars: num(options.maxDetailChars, 500),
    excludedTools: new Set(list.map(t => String(t).trim()).filter(Boolean)),
    exportDir: str(options.exportDir),
    dataDir: str(options.dataDir),
  }
}

// Module state: the options of this load, and the debounced writer's bookkeeping.
let opts: Options = readOptions({})
let timer: { cancel: () => void } | undefined
let isDirty = false
let lastText: string | undefined
let lastPath: string | undefined

async function graphDir($: EngineInterface) {
  return opts.dataDir.trim() !== '' ? trimSlash(opts.dataDir) : `${await $.session.root()}/.claude/dag`
}

async function graphPath($: EngineInterface, sessionId: string) {
  return `${await graphDir($)}/${sessionId}.json`
}

async function loadGraph($: EngineInterface, sessionId: string) {
  const path = await graphPath($, sessionId)
  try {
    return (await $.fs.exists(path)) ? parseGraph(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

async function writeIndex($: EngineInterface, sessionId: string, enabled: boolean, file: string, updatedAt: number) {
  const index = asIndex(await $.store.get(INDEX_KEY))
  await $.store.set(INDEX_KEY, withEntry(index, sessionId, { enabled, file, updatedAt }))
}

async function enabledFor($: EngineInterface, sessionId: string) {
  return asIndex(await $.store.get(INDEX_KEY))[sessionId]?.enabled ?? true
}

async function flush($: EngineInterface) {
  timer = undefined
  if (!isDirty) return
  isDirty = false
  const g = await read($, graphAtom)
  if (!g) return
  lastText = serializeWithin(g, FILE_BUDGET, opts.windowTurns).text
  lastPath = await graphPath($, g.sessionId)
  await $.fs.write(lastPath, lastText)
  await writeIndex($, g.sessionId, g.enabled, lastPath, g.updatedAt)
}

/** At most one write per FLUSH_MS; the latest serialized text is kept for session.end. */
function schedule($: EngineInterface) {
  isDirty = true
  if (timer) return
  timer = $.clock.after(FLUSH_MS, () => {
    void flush($).catch(() => {})
  })
}

async function setGraph($: EngineInterface, g: DagFile | null) {
  await update($, graphAtom, () => g)
  if (g) schedule($)
}

async function isOn($: EngineInterface) {
  return (await read($, graphAtom))?.enabled === true
}

/** Applies one event to the live graph; never throws into the hook that captured it. */
async function apply($: EngineInterface, ev: DagEvent) {
  try {
    let changed = false
    await update($, graphAtom, g => {
      if (!g || !g.enabled) return g
      const next = reduce(g, ev, { maxDetailChars: opts.maxDetailChars })
      changed = next !== g
      return next
    })
    if (changed) schedule($)
  } catch {
    // Capture is best effort: a lost node never blocks the session.
  }
}

async function transcriptGraph($: EngineInterface, sessionId: string, live: DagFile | null) {
  const rows = (await $.session.messages({ as: 'api' })) as unknown
  const at = await $.clock.now()
  const rebuilt = rebuild(Array.isArray(rows) ? (rows as ApiRow[]) : [], sessionId, at, { maxDetailChars: opts.maxDetailChars })
  return mergeLive(rebuilt, live)
}

/** The graph a session opens with: the live one, its file, the transcript, or a new one. */
async function openGraph($: EngineInterface, sessionId: string, source: string): Promise<DagFile> {
  const live = await read($, graphAtom)
  if (source !== 'clear' && live?.sessionId === sessionId) return live
  const enabled = await enabledFor($, sessionId)
  if (source === 'clear') return emptyGraph(sessionId, await $.clock.now(), enabled)
  const saved = source === 'fork' ? null : await loadGraph($, sessionId)
  if (saved) return { ...saved, sessionId, enabled }
  if (source === 'startup') return emptyGraph(sessionId, await $.clock.now(), enabled)
  return { ...(await transcriptGraph($, sessionId, null)), enabled }
}

async function exportGraph($: EngineInterface, format: string): Promise<string> {
  const g = await read($, graphAtom)
  if (!g) return 'There is no graph to export yet.'
  const dir = opts.exportDir.trim() !== '' ? trimSlash(opts.exportDir) : `${await graphDir($)}/exports`
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const base = `${dir}/${g.sessionId}-${stamp}`

  if (format === 'json') {
    const { text, graph } = serializeWithin(g, FILE_BUDGET, opts.windowTurns)
    await $.fs.write(`${base}.json`, text)
    return `Exported the graph (${graph.nodes.length} nodes${graph === g ? '' : ', trimmed to fit 4 MiB'}) to ${base}.json`
  }
  const svg = exportSvg(g)
  await $.fs.write(`${base}.svg`, svg.source)
  const note = svg.turns > 0 ? ` (the last ${svg.turns} turns, to fit 4 MiB)` : ''
  if (format === 'svg') return `Exported the graph${note} to ${base}.svg`

  const converters: string[][] = [
    ['rsvg-convert', '-o', `${base}.png`, `${base}.svg`],
    ['resvg', `${base}.svg`, `${base}.png`],
  ]
  for (const argv of converters) {
    try {
      const run = await $.process.run(argv, { timeoutMs: 60_000 })
      if (run.exitCode === 0) return `Exported the graph to ${base}.png (with ${argv[0]})`
    } catch {
      // Not installed: try the next converter.
    }
  }
  return `No PNG converter found (install rsvg-convert or resvg). Wrote the SVG instead: ${base}.svg`
}

/** The whole graph as SVG, or the most recent turns that fit the file limit. */
function exportSvg(g: DagFile): { source: string; turns: number } {
  const all = toSvg(layout(g, visibleTree(g, 0)), { titles: true, background: true })
  if (all.length * 3 <= FILE_BUDGET || new TextEncoder().encode(all).length <= FILE_BUDGET) return { source: all, turns: 0 }
  let turns = g.nodes.filter(n => n.kind === 'turn' && !n.agentId).length
  for (;;) {
    turns = Math.max(1, Math.floor(turns / 2))
    const source = toSvg(layout(g, visibleTree(g, turns)), { titles: true, background: true })
    if (turns === 1 || new TextEncoder().encode(source).length <= FILE_BUDGET) return { source, turns }
  }
}

async function setEnabled($: EngineInterface, enabled: boolean) {
  const id = await $.session.id()
  const live = await read($, graphAtom)
  const own = live?.sessionId === id ? live : null
  const g = enabled
    ? { ...(await transcriptGraph($, id, own)), enabled: true } // backfill the gap
    : { ...(own ?? emptyGraph(id, await $.clock.now())), enabled: false }
  await setGraph($, g)
  await writeIndex($, id, enabled, await graphPath($, id), await $.clock.now())
}

async function isPaneOpen($: EngineInterface) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

export const register: Register = (on, options) => {
  opts = readOptions(options)

  // ---- session lifecycle ----

  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.source !== 'compact') {
        lastText = undefined
        await setGraph($, await openGraph($, e.session_id, e.source))
      }
    } catch {
      // A graph that cannot be opened starts empty at the next session.start.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dag',
      description: 'Conversation DAG: open or close the pane, turn capture on or off, export the graph',
      argumentHint: '[on|off|export json|svg|png]',
    })
    try {
      const id = await $.session.id()
      const live = await read($, graphAtom)
      if (live?.sessionId !== id) await setGraph($, await openGraph($, id, 'startup'))
    } catch {
      // Same as above.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    try {
      if (isDirty) {
        const g = await read($, graphAtom)
        if (g) {
          lastText = serializeWithin(g, FILE_BUDGET, opts.windowTurns).text
          lastPath = await graphPath($, g.sessionId)
        }
      }
      if (lastText && lastPath) await $.fs.write(lastPath, lastText)
      isDirty = false
    } catch {
      // The file is a cache: the transcript rebuilds it.
    }
    return next(e)
  })

  // ---- capture ----

  on('turn.start', async ($, e, next) => {
    if (await isOn($)) await apply($, { type: 'turnStart', turnId: e.turnId, text: e.text, at: await $.clock.now() })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isCapturing = await isOn($).catch(() => false)
    if (isCapturing) {
      await apply($, { type: 'stepStart', turnId: e.turnId, index: e.index, agentId: e.agentId, model: e.model, at: await $.clock.now() })
    }
    const result = yield* next(e)
    if (isCapturing) {
      await apply($, { type: 'stepEnd', turnId: e.turnId, index: e.index, agentId: e.agentId, usage: result.usage ?? undefined, at: await $.clock.now() })
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    if (e.door === 'response' && Array.isArray(e.message.content) && (await isOn($))) {
      const at = await $.clock.now()
      let i = 0
      for (const block of e.message.content as { type?: string; text?: string; thinking?: string }[]) {
        const kind = block.type === 'text' ? 'text' : block.type === 'thinking' || block.type === 'redacted_thinking' ? 'thinking' : undefined
        if (kind) {
          await apply($, {
            type: 'block',
            uuid: `${e.uuid}:${i}`,
            agentId: e.agentId,
            kind,
            text: (kind === 'text' ? block.text : block.thinking) ?? '',
            at,
          })
        }
        i += 1
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const track = id !== undefined && !opts.excludedTools.has(String(e.tool)) && (await isOn($))
    if (track) {
      const { tool, tool_use_id, consent, agentId, ...input } = e as Record<string, unknown>
      void tool_use_id
      void consent
      await apply($, {
        type: 'toolStart',
        toolUseId: id,
        tool: String(tool),
        agentId: agentId as string | undefined,
        input: JSON.stringify(input),
        at: await $.clock.now(),
      })
    }
    const ran = await next(e)
    if (track) {
      const status: DagStatus = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
      const result = ran.deny ?? ('text' in ran && typeof ran.text === 'string' ? ran.text : '')
      await apply($, { type: 'toolEnd', toolUseId: id, status, result, at: await $.clock.now() })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId && (await isOn($))) {
      await apply($, {
        type: 'spawned',
        toolUseId: e.tool_use_id,
        agentId: ran.agentId,
        subagentType: e.subagentType,
        description: e.description,
        parentAgentId: e.parentAgentId,
        at: await $.clock.now(),
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (await isOn($)) {
      await apply($, {
        type: 'turnEnd',
        turnId: e.turnId,
        agentId: e.agentId,
        reason: e.reason,
        answer: 'answer' in e && typeof e.answer === 'string' ? e.answer : '',
        usage: e.usage,
        at: await $.clock.now(),
      })
    }
    return next(e)
  })

  // ---- commands ----

  on('command.run', { command: 'dag' }, async ($, e) => {
    const [verb = '', format = ''] = e.args.trim().toLowerCase().split(/\s+/)
    switch (verb) {
      case '': {
        if (await isPaneOpen($)) {
          await $.ui.close({ id: PANE })
          return { text: 'DAG pane closed.' }
        }
        const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
        return { text: isPlaced ? 'DAG pane opened.' : 'DAG pane opened; this surface does not show panes right now.' }
      }
      case 'on':
        await setEnabled($, true)
        return { text: 'DAG capture is on for this session; the gap was backfilled from the transcript.' }
      case 'off':
        await setEnabled($, false)
        if (await isPaneOpen($)) await $.ui.close({ id: PANE })
        return { text: 'DAG capture is off for this session.' }
      case 'export':
        if (!['json', 'svg', 'png'].includes(format)) return { text: 'Usage: /dag export json|svg|png' }
        try {
          return { text: await exportGraph($, format) }
        } catch (err) {
          return { text: `Export failed: ${String(err)}` }
        }
      default:
        return { text: 'Usage: /dag [on|off|export json|svg|png]' }
    }
  })

  // ---- drawing ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    return drawPane({
      surface: e.surface,
      els,
      graph: await read($, graphAtom),
      selected: await read($, selectedAtom),
      windowTurns: opts.windowTurns,
      columns: e.props.bodyColumns,
      onSelect: value => void update($, selectedAtom, () => value),
    })
  })
}
