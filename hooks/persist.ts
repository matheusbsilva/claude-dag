import type { DagFile } from '../types'

export type SessionIndexEntry = { enabled: boolean; file: string; updatedAt: number }
export type SessionIndex = Record<string, SessionIndexEntry>

export const INDEX_LIMIT = 200

export const asIndex = (value: unknown): SessionIndex =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as SessionIndex) : {}

/** The index with one session's entry set, keeping the newest INDEX_LIMIT entries. */
export const withEntry = (index: SessionIndex, sessionId: string, entry: SessionIndexEntry): SessionIndex =>
  Object.fromEntries(
    Object.entries({ ...index, [sessionId]: entry })
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, INDEX_LIMIT),
  )

export const isDagFile = (value: unknown): value is DagFile =>
  !!value &&
  typeof value === 'object' &&
  (value as DagFile).schemaVersion === 1 &&
  Array.isArray((value as DagFile).nodes) &&
  Array.isArray((value as DagFile).edges)

/** A saved graph's text as a graph, or null when it does not parse as one. */
export const parseGraph = (text: string): DagFile | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isDagFile(parsed) ? { ...parsed, cursors: parsed.cursors ?? {} } : null
  } catch {
    return null
  }
}

export const trimSlash = (dir: string) => dir.replace(/\/+$/, '')

/** What `$.fs` reads and writes at most, less a margin. */
export const FILE_BUDGET = 4 * 1024 * 1024 - 64 * 1024

const byteLength = (text: string) => new TextEncoder().encode(text).length

const withoutDetails = (g: DagFile, keep: (id: string) => boolean): DagFile => ({
  ...g,
  nodes: g.nodes.map(n => (keep(n.id) || (n.detail === undefined && n.result === undefined) ? n : { ...n, detail: undefined, result: undefined })),
})

/** The main-loop turns in order and the nodes under each (contains/spawns closure). */
const turnSubtrees = (g: DagFile): string[][] => {
  const kids = new Map<string, string[]>()
  for (const e of g.edges) {
    if (e.kind === 'sequence') continue
    const list = kids.get(e.from) ?? []
    list.push(e.to)
    kids.set(e.from, list)
  }
  return g.nodes
    .filter(n => n.kind === 'turn' && !n.agentId)
    .map(t => {
      const out = [t.id]
      for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]!) ?? []))
      return out
    })
}

/**
 * The graph as text that fits `budget` bytes: whole when it fits; else without the
 * details of turns before the last `keepTurns`; then with the oldest turns dropped
 * (counted in `droppedTurns`).
 */
export const serializeWithin = (g: DagFile, budget: number, keepTurns: number): { text: string; graph: DagFile } => {
  let text = JSON.stringify(g)
  if (byteLength(text) <= budget) return { text, graph: g }

  const turns = turnSubtrees(g)
  const recent = new Set(turns.slice(-keepTurns).flat())
  let graph = withoutDetails(g, id => recent.has(id))
  text = JSON.stringify(graph)
  if (byteLength(text) <= budget) return { text, graph }

  let dropped = 0
  while (byteLength(text) > budget && dropped < turns.length - 1) {
    // Drop by the share of the text over budget, at least one turn at a time.
    const over = byteLength(text) / budget
    dropped = Math.min(turns.length - 1, dropped + Math.max(1, Math.ceil((turns.length - dropped) * (1 - 1 / over))))
    const gone = new Set(turns.slice(0, dropped).flat())
    const trimmed = withoutDetails(g, id => recent.has(id))
    graph = {
      ...trimmed,
      nodes: trimmed.nodes.filter(n => !gone.has(n.id)),
      edges: g.edges.filter(e => !gone.has(e.from) && !gone.has(e.to)),
      droppedTurns: (g.droppedTurns ?? 0) + dropped,
    }
    text = JSON.stringify(graph)
  }
  return { text, graph }
}
