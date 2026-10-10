import type { DagCursor, DagEdgeKind, DagFile, DagNode, DagStatus } from '../types'

import {
  MAIN,
  agentNodeId,
  blockNodeId,
  firstLine,
  stepNodeId,
  toolNodeId,
  turnNodeId,
} from './model'
import type { DagEvent } from './model'

const loopOf = (agentId: string | undefined) => agentId ?? MAIN

const edgeKey = (from: string, to: string, kind: DagEdgeKind) => `${kind}\u0000${from}\u0000${to}`

const statusOfTurn = (reason: string): DagStatus =>
  reason === 'answer' ? 'ok' : reason === 'aborted' ? 'denied' : 'error'

/** Every node reachable from `root` along contains/spawns edges, root included. */
export const subtree = (g: Pick<DagFile, 'edges'>, root: string): Set<string> => {
  const kids = new Map<string, string[]>()
  for (const e of g.edges) {
    if (e.kind === 'sequence') continue
    const list = kids.get(e.from) ?? []
    list.push(e.to)
    kids.set(e.from, list)
  }
  const seen = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const to of kids.get(queue.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  return seen
}

export type ReduceOptions = { maxDetailChars: number }

/**
 * A working copy of a graph that events are applied to in place, with an index by id,
 * so a batch of events costs one copy of the graph rather than one per event.
 */
class Draft {
  nodes: DagNode[]
  edges: DagFile['edges']
  cursors: Record<string, DagCursor>
  lastTurnId: string | undefined
  updatedAt: number
  isChanged = false
  private index = new Map<string, number>()
  private edgeKeys = new Set<string>()

  constructor(private g: DagFile, private opts: ReduceOptions) {
    this.nodes = [...g.nodes]
    this.edges = [...g.edges]
    this.cursors = { ...g.cursors }
    this.lastTurnId = g.lastTurnId
    this.updatedAt = g.updatedAt
    this.nodes.forEach((n, i) => this.index.set(n.id, i))
    for (const e of this.edges) this.edgeKeys.add(edgeKey(e.from, e.to, e.kind))
  }

  has(id: string) {
    return this.index.has(id)
  }

  get(id: string) {
    const i = this.index.get(id)
    return i === undefined ? undefined : this.nodes[i]
  }

  add(node: DagNode) {
    if (this.has(node.id)) return
    this.index.set(node.id, this.nodes.length)
    this.nodes.push(node)
    this.isChanged = true
  }

  patch(id: string, patch: Partial<DagNode>) {
    const i = this.index.get(id)
    if (i === undefined) return
    this.nodes[i] = { ...this.nodes[i]!, ...patch }
    this.isChanged = true
  }

  link(from: string | undefined, to: string, kind: DagEdgeKind) {
    if (!from || from === to) return
    const key = edgeKey(from, to, kind)
    if (this.edgeKeys.has(key)) return
    this.edgeKeys.add(key)
    this.edges.push({ from, to, kind })
    this.isChanged = true
  }

  cursor(loop: string, patch: DagCursor) {
    this.cursors[loop] = { ...this.cursors[loop], ...patch }
    this.isChanged = true
  }

  detail(text: string) {
    const max = this.opts.maxDetailChars
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  /** The node new content of a loop hangs from: its current step, else its turn or agent. */
  anchorOf(agentId: string | undefined): string | undefined {
    const cursor = this.cursors[loopOf(agentId)]
    if (cursor?.stepId) return cursor.stepId
    if (agentId) return this.has(agentNodeId(agentId)) ? agentNodeId(agentId) : undefined
    return cursor?.turnId ? turnNodeId(cursor.turnId) : undefined
  }

  /** Closes every running node under `root`: what a turn's end leaves unfinished. */
  closeRunning(root: string, at: number, status: DagStatus): Set<string> {
    const inside = subtree(this, root)
    for (const id of inside) {
      const n = this.get(id)
      if (n && n.status === 'running') this.patch(id, { status, endedAt: n.endedAt ?? at })
    }
    return inside
  }

  apply(ev: DagEvent) {
    switch (ev.type) {
      case 'turnStart': {
        const id = turnNodeId(ev.turnId)
        if (this.has(id)) return
        this.add({
          id,
          kind: 'turn',
          label: firstLine(ev.text) || '(continuation)',
          status: 'running',
          startedAt: ev.at,
          detail: this.detail(ev.text),
        })
        this.link(this.lastTurnId, id, 'sequence')
        this.lastTurnId = id
        this.cursor(MAIN, { turnId: ev.turnId, stepId: undefined, lastStepId: undefined })
        break
      }

      case 'stepStart': {
        const id = stepNodeId(ev.turnId, ev.index)
        if (this.has(id)) return
        const loop = loopOf(ev.agentId)
        if (ev.agentId) {
          this.add({ id: agentNodeId(ev.agentId), kind: 'subagent', label: 'subagent', status: 'running', startedAt: ev.at, agentId: ev.agentId })
        }
        const cursor = this.cursors[loop]
        this.add({
          id,
          kind: 'step',
          label: `step ${ev.index + 1}`,
          status: 'running',
          startedAt: ev.at,
          detail: ev.model,
          agentId: ev.agentId,
        })
        const container = ev.agentId ? agentNodeId(ev.agentId) : turnNodeId(ev.turnId)
        if (this.has(container)) this.link(container, id, 'contains')
        if (cursor?.turnId === ev.turnId) this.link(cursor.lastStepId, id, 'sequence')
        this.cursor(loop, { turnId: ev.turnId, stepId: id, lastStepId: id })
        break
      }

      case 'stepEnd':
        this.patch(stepNodeId(ev.turnId, ev.index), { status: 'ok', endedAt: ev.at, usage: ev.usage })
        break

      case 'block': {
        const id = blockNodeId(ev.uuid)
        if (this.has(id)) return
        const anchor = this.anchorOf(ev.agentId)
        const isThinking = ev.kind === 'thinking'
        this.add({
          id,
          kind: 'reasoning',
          label: isThinking ? 'thinking' : firstLine(ev.text) || 'text',
          status: 'ok',
          startedAt: ev.at,
          endedAt: ev.at,
          detail: isThinking && !ev.text ? 'thinking (hidden)' : this.detail(ev.text),
          agentId: ev.agentId,
        })
        this.link(anchor, id, 'contains')
        break
      }

      case 'toolStart': {
        const id = toolNodeId(ev.toolUseId)
        if (this.has(id)) return
        const anchor = this.anchorOf(ev.agentId)
        this.add({
          id,
          kind: 'tool',
          label: ev.tool,
          status: 'running',
          startedAt: ev.at,
          detail: this.detail(ev.input),
          agentId: ev.agentId,
          toolUseId: ev.toolUseId,
        })
        this.link(anchor, id, 'contains')
        break
      }

      case 'toolEnd':
        this.patch(toolNodeId(ev.toolUseId), { status: ev.status, endedAt: ev.at, result: this.detail(ev.result) })
        break

      case 'spawned': {
        const id = agentNodeId(ev.agentId)
        const label = `${ev.subagentType}: ${firstLine(ev.description, 40)}`
        if (this.has(id)) this.patch(id, { label, detail: this.detail(ev.description) })
        else {
          this.add({
            id,
            kind: 'subagent',
            label,
            status: 'running',
            startedAt: ev.at,
            detail: this.detail(ev.description),
            agentId: ev.agentId,
          })
        }
        const tool = toolNodeId(ev.toolUseId)
        this.link(this.has(tool) ? tool : this.anchorOf(ev.parentAgentId), id, 'spawns')
        break
      }

      case 'turnEnd': {
        const status = statusOfTurn(ev.reason)
        const id = ev.agentId ? agentNodeId(ev.agentId) : turnNodeId(ev.turnId)
        if (!this.has(id)) return
        const inside = this.closeRunning(id, ev.at, status)
        const childFailed =
          !ev.agentId && [...inside].some(c => c !== id && this.get(c)?.status === 'error')
        this.patch(id, {
          status: status === 'ok' && childFailed ? 'error' : status,
          endedAt: ev.at,
          result: this.detail(ev.answer),
          usage: ev.usage,
        })
        this.cursor(loopOf(ev.agentId), { stepId: undefined })
        break
      }
    }
    if (this.isChanged) this.updatedAt = ev.at
  }

  done(): DagFile {
    if (!this.isChanged) return this.g
    return {
      ...this.g,
      nodes: this.nodes,
      edges: this.edges,
      cursors: this.cursors,
      lastTurnId: this.lastTurnId,
      updatedAt: this.updatedAt,
    }
  }
}

/** Pure: the graph after a batch of events. Unknown references are tolerated, never thrown on. */
export const reduceAll = (g: DagFile, events: readonly DagEvent[], opts: ReduceOptions): DagFile => {
  const draft = new Draft(g, opts)
  for (const ev of events) draft.apply(ev)
  return draft.done()
}

/** Pure: the graph after one event; the same graph when the event changes nothing. */
export const reduce = (g: DagFile, ev: DagEvent, opts: ReduceOptions): DagFile => reduceAll(g, [ev], opts)
