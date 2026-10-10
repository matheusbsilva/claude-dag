import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ApiRow } from '../hooks/rebuild'
import type { DagFile } from '../types'

export type Harness = {
  files: Map<string, string>
  panes: Set<string>
  transcript: ApiRow[]
  /** The session the graph is kept for: the kit's own session id unless a test moves on. */
  sessionId: string
  /** The kit's session id, which `$.session.id()` answers. */
  mainId: string
  clock: ReturnType<typeof mock.clock>
}

export const ROOT = '/proj'

/**
 * Stands in for the engine beneath the plugin: an in-memory filesystem, the session's
 * id and root, a transcript, panes, a mocked clock and store, and a bottom for every
 * event the plugin hooks.
 */
export const install = async ($: Engine, on: On): Promise<Harness> => {
  void $
  const h: Harness = {
    files: new Map(),
    panes: new Set(),
    transcript: [],
    sessionId: '',
    mainId: '',
    clock: mock.clock(on, { now: 1_000_000 }),
  }
  mock.store(on)
  on('session.id', () => ({ value: h.sessionId }))
  on('session.root', () => ({ value: ROOT }))
  on('session.messages', () => ({ value: h.transcript as never }))
  on('fs.exists', ($, e) => ({ value: h.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: h.files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    h.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    h.panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    h.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...h.panes].map(id => ({ id })) as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('classic.SessionStart', ($, e) => {
    // The kit stamps its own session id on an event raised without one: what `$.session.id()` answers.
    if (!h.mainId && e.source === 'startup') h.mainId = e.session_id
    return {}
  })
  on('session.start', () => ({ cwd: ROOT }) as never)
  on('session.end', () => ({ sessionId: h.sessionId }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', ($, e) => {
    const tool = String(e.tool)
    return (tool === 'Denied' ? { deny: 'no' } : { result: {}, text: `ran ${tool}`, isError: tool === 'Broken' }) as never
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub-1' }))
  return h
}

export const graphOf = (h: Harness, id = h.sessionId): DagFile | undefined => {
  const text = h.files.get(`${ROOT}/.claude/dag/${id}.json`)
  return text ? JSON.parse(text) : undefined
}

/** The graph as the debounced writer saved it, once its delay has passed. */
export const saved = async (h: Harness, id = h.sessionId): Promise<DagFile> => {
  await h.clock.advance(1500)
  const g = graphOf(h, id)
  if (!g) throw new Error(`no graph saved for ${id}`)
  return g
}

/** Raises SessionStart for the harness's current session. */
export const start = async (h: Harness, $: Engine, source: 'startup' | 'resume' | 'clear' | 'fork') => {
  await $.classic.SessionStart(h.sessionId ? { source, session_id: h.sessionId } : { source })
  if (!h.sessionId) h.sessionId = h.mainId
}
