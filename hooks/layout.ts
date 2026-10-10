import type { DagEdge, DagFile, DagNode } from '../types'

/** One visible node with its children, in drawing order. */
export type TreeItem = { node: DagNode; children: TreeItem[] }

export type VisibleTree = {
  /** Main-loop turns before the window, folded into one summary. */
  collapsed: number
  turns: TreeItem[]
}

const byStart = (a: DagNode, b: DagNode) => a.startedAt - b.startedAt

/** The main-loop turns in order, and each node's children along contains/spawns edges. */
export const visibleTree = (g: DagFile, windowTurns: number): VisibleTree => {
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const kids = new Map<string, DagNode[]>()
  for (const e of g.edges) {
    if (e.kind === 'sequence') continue
    const child = byId.get(e.to)
    if (!child) continue
    const list = kids.get(e.from) ?? []
    list.push(child)
    kids.set(e.from, list)
  }
  const seen = new Set<string>()
  const build = (node: DagNode): TreeItem => {
    seen.add(node.id)
    const children = (kids.get(node.id) ?? [])
      .filter(c => !seen.has(c.id))
      .sort(byStart)
      .map(build)
    return { node, children }
  }
  const turns = g.nodes.filter(n => n.kind === 'turn' && !n.agentId)
  const shown = windowTurns > 0 ? turns.slice(-windowTurns) : turns
  return { collapsed: turns.length - shown.length + (g.droppedTurns ?? 0), turns: shown.map(build) }
}

export const formatDuration = (node: DagNode): string => {
  if (node.endedAt === undefined || node.kind === 'reasoning') return ''
  const ms = Math.max(0, node.endedAt - node.startedAt)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const STATUS_MARK: Record<DagNode['status'], string> = {
  running: '…',
  ok: '✓',
  error: '✗',
  denied: '⊘',
}

/** Flattened lines for the terminal's indented tree. */
export type TreeLine = { id: string; depth: number; node: DagNode }

export const flatten = (tree: VisibleTree): TreeLine[] => {
  const out: TreeLine[] = []
  const walk = (item: TreeItem, depth: number) => {
    out.push({ id: item.node.id, depth, node: item.node })
    for (const c of item.children) walk(c, depth + 1)
  }
  for (const t of tree.turns) walk(t, 0)
  return out
}

// ---- 2D layout, shared by the desktop pane and the SVG export ----

export type Box = { id: string; x: number; y: number; w: number; h: number; node: DagNode }
export type Line = { from: string; to: string; kind: DagEdge['kind']; d: string }
export type Layout = { width: number; height: number; boxes: Box[]; lines: Line[]; collapsed?: Box }

export const GEOMETRY = {
  pad: 16,
  boxH: 26,
  turnW: 220,
  colW: 200,
  gapX: 28,
  gapY: 8,
  indent: 14,
  rowGap: 28,
  minW: 90,
}

/**
 * Turns run top to bottom; within a turn, steps run left to right with their content
 * stacked under them; a subagent sits under the tool that spawned it, indented, with
 * its own steps and tools indented further.
 */
export const layout = (g: DagFile, tree: VisibleTree): Layout => {
  const G = GEOMETRY
  const boxes: Box[] = []
  let y = G.pad
  let width = G.pad * 2 + G.turnW
  let collapsed: Box | undefined

  if (tree.collapsed > 0) {
    collapsed = {
      id: 'collapsed',
      x: G.pad,
      y,
      w: G.turnW,
      h: G.boxH,
      node: {
        id: 'collapsed',
        kind: 'turn',
        label: `${tree.collapsed} earlier turn${tree.collapsed === 1 ? '' : 's'}`,
        status: 'ok',
        startedAt: 0,
      },
    }
    y += G.boxH + G.rowGap
  }

  for (const turn of tree.turns) {
    boxes.push({ id: turn.node.id, x: G.pad, y, w: G.turnW, h: G.boxH, node: turn.node })
    let bottom = y + G.boxH
    const steps = turn.children.filter(c => c.node.kind === 'step')
    const loose = turn.children.filter(c => c.node.kind !== 'step')

    const stack = (items: TreeItem[], x: number, top: number, w: number, depth: number): number => {
      let cy = top
      for (const item of items) {
        const ix = x + depth * G.indent
        const iw = Math.max(G.minW, w - depth * G.indent)
        boxes.push({ id: item.node.id, x: ix, y: cy, w: iw, h: G.boxH, node: item.node })
        cy += G.boxH + G.gapY
        cy = stack(item.children, x, cy, w, depth + 1)
      }
      return cy
    }

    if (loose.length > 0) bottom = Math.max(bottom, stack(loose, G.pad, y + G.boxH + G.gapY, G.turnW, 1) - G.gapY)

    steps.forEach((step, j) => {
      const x = G.pad + G.turnW + G.gapX + j * (G.colW + G.gapX)
      boxes.push({ id: step.node.id, x, y, w: G.colW, h: G.boxH, node: step.node })
      const end = stack(step.children, x, y + G.boxH + G.gapY, G.colW, 1)
      bottom = Math.max(bottom, end - G.gapY)
      width = Math.max(width, x + G.colW + G.pad)
    })
    y = bottom + G.rowGap
  }

  const at = new Map(boxes.map(b => [b.id, b]))
  const lines: Line[] = []
  for (const e of g.edges) {
    const a = at.get(e.from)
    const b = at.get(e.to)
    if (!a || !b) continue
    let d: string
    if (a.y === b.y) {
      d = `M${a.x + a.w},${a.y + a.h / 2} H${b.x}`
    } else if (e.kind === 'sequence' && a.node.kind === 'turn' && b.node.kind === 'turn') {
      d = `M${a.x + 20},${a.y + a.h} V${b.y}`
    } else if (e.kind !== 'sequence' && b.y > a.y && b.x > a.x) {
      d = `M${a.x + 8},${a.y + a.h} V${b.y + b.h / 2} H${b.x}`
    } else {
      continue
    }
    lines.push({ from: e.from, to: e.to, kind: e.kind, d })
  }
  if (collapsed && tree.turns[0]) {
    lines.push({ from: 'collapsed', to: tree.turns[0].node.id, kind: 'sequence', d: `M${G.pad + 20},${collapsed.y + G.boxH} V${collapsed.y + G.boxH + G.rowGap}` })
  }

  return { width, height: Math.max(y - G.rowGap + G.pad, G.pad * 2 + G.boxH), boxes, lines, collapsed }
}
