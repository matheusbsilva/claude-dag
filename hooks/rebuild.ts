import type { DagFile } from '../types'

import { emptyGraph } from './model'
import type { DagEvent } from './model'
import { reduceAll } from './reduce'
import type { ReduceOptions } from './reduce'

/** The API-shaped rows `$.session.messages({ as: 'api' })` answers, read loosely. */
export type ApiRow = { role: string; content: unknown }

type Block = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? (content.filter(b => b && typeof b === 'object') as Block[])
      : []

const isReminder = (text: string) => /^\s*<(system-reminder|local-command|command-)/.test(text)

const textOfResult = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .map(b => b.text ?? '')
        .join('\n')

/**
 * Rebuilds the main loop's graph from the transcript. In the API shape each assistant
 * row is one model request (a step), its parallel tool_use blocks together. A user row
 * with prompt text and no tool_result starts a turn. Subagent internals and timings are
 * not in the transcript: rebuilt nodes carry `at` as their time.
 */
export const rebuild = (
  rows: readonly ApiRow[],
  sessionId: string,
  at: number,
  opts: ReduceOptions,
): DagFile => {
  const events: DagEvent[] = []
  let turn = -1
  let step = 0
  let turnOpen = false
  const pending = new Map<string, true>()
  let blockSeq = 0

  const endTurn = () => {
    if (!turnOpen) return
    for (const id of pending.keys()) events.push({ type: 'toolEnd', toolUseId: id, status: 'ok', result: '', at })
    pending.clear()
    events.push({ type: 'turnEnd', turnId: `r${turn}`, reason: 'answer', answer: '', at })
    turnOpen = false
  }

  for (const row of rows) {
    const blocks = blocksOf(row.content)
    if (row.role === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      for (const r of results) {
        if (!r.tool_use_id) continue
        pending.delete(r.tool_use_id)
        events.push({
          type: 'toolEnd',
          toolUseId: r.tool_use_id,
          status: r.is_error ? 'error' : 'ok',
          result: textOfResult(r.content),
          at,
        })
      }
      const prompt = blocks
        .filter(b => b.type === 'text' && b.text && !isReminder(b.text))
        .map(b => b.text!)
        .join('\n')
      if (results.length === 0 && prompt.trim() !== '') {
        endTurn()
        turn += 1
        step = 0
        turnOpen = true
        events.push({ type: 'turnStart', turnId: `r${turn}`, text: prompt, at })
      }
      continue
    }

    if (row.role !== 'assistant' || !turnOpen) continue
    events.push({ type: 'stepStart', turnId: `r${turn}`, index: step, model: '', at })
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        events.push({ type: 'block', uuid: `r${turn}-${blockSeq++}`, kind: 'text', text: b.text, at })
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        events.push({ type: 'block', uuid: `r${turn}-${blockSeq++}`, kind: 'thinking', text: b.thinking ?? '', at })
      } else if (b.type === 'tool_use' && b.id) {
        pending.set(b.id, true)
        events.push({
          type: 'toolStart',
          toolUseId: b.id,
          tool: b.name ?? 'tool',
          input: JSON.stringify(b.input ?? {}),
          at,
        })
      }
    }
    events.push({ type: 'stepEnd', turnId: `r${turn}`, index: step, at })
    step += 1
  }
  endTurn()

  return reduceAll(emptyGraph(sessionId, at), events, opts)
}

/**
 * The rebuilt graph, with what live capture knew and the transcript does not kept:
 * each tool's timings and result, and every subagent loop with its nodes.
 */
export const mergeLive = (rebuilt: DagFile, live: DagFile | null): DagFile => {
  if (!live) return rebuilt
  const liveById = new Map(live.nodes.map(n => [n.id, n]))
  const nodes = rebuilt.nodes.map(n => {
    const known = n.kind === 'tool' ? liveById.get(n.id) : undefined
    return known ? { ...n, ...known } : n
  })
  const ids = new Set(nodes.map(n => n.id))
  for (const n of live.nodes) {
    if (!ids.has(n.id) && (n.kind === 'subagent' || n.agentId)) {
      nodes.push(n)
      ids.add(n.id)
    }
  }
  const edges = [...rebuilt.edges]
  for (const e of live.edges) {
    const isNew = !edges.some(x => x.from === e.from && x.to === e.to && x.kind === e.kind)
    if (isNew && ids.has(e.from) && ids.has(e.to)) edges.push(e)
  }
  return { ...rebuilt, nodes, edges, cursors: { ...live.cursors, ...rebuilt.cursors } }
}
