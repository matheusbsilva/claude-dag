import type { Elements, RenderSurface } from 'claude-code'

import type { DagFile, DagNode } from '../types'

import { STATUS_MARK, flatten, formatDuration, layout, visibleTree } from './layout'
import { toSvg } from './svg'

export const SVG_LIMIT = 131_072
const TREE_LINE_LIMIT = 400

const COLOR: Record<DagNode['status'], string> = {
  running: 'blue',
  ok: 'green',
  error: 'red',
  denied: 'yellow',
}

/** The pane's SVG, its window shrunk until the markup fits the element's cap. */
export const paneSvg = (g: DagFile, windowTurns: number): { source: string; turns: number } => {
  let turns = windowTurns
  for (;;) {
    const source = toSvg(layout(g, visibleTree(g, turns)), { titles: true })
    if (source.length <= SVG_LIMIT) return { source, turns }
    const plain = toSvg(layout(g, visibleTree(g, turns)), { titles: false })
    if (plain.length <= SVG_LIMIT) return { source: plain, turns }
    if (turns <= 1) return { source: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', turns: 0 }
    turns = Math.max(1, Math.floor(turns / 2))
  }
}

const describe = (n: DagNode): string =>
  [
    `${n.kind} · ${n.label} · ${n.status}${formatDuration(n) ? ` · ${formatDuration(n)}` : ''}`,
    n.detail ? `input: ${n.detail}` : '',
    n.result ? `result: ${n.result}` : '',
    n.usage ? `tokens: ${n.usage.input_tokens ?? 0} in / ${n.usage.output_tokens ?? 0} out` : '',
  ]
    .filter(Boolean)
    .join('\n')

export type PaneInput = {
  surface: RenderSurface
  els: Elements[RenderSurface]
  graph: DagFile | null
  selected: string | null
  windowTurns: number
  columns: number
  onSelect: (value: string) => void
}

export const drawPane = ({ surface, els, graph, selected, windowTurns, columns, onSelect }: PaneInput) => {
  const { Box, Text } = els
  if (!graph) return <Text dimColor>No graph yet.</Text>
  if (!graph.enabled) return <Text dimColor>DAG capture is off for this session. Run /dag on to resume.</Text>

  const tree = visibleTree(graph, windowTurns)
  const lines = flatten(tree)
  if (lines.length === 0) return <Text dimColor>No turns yet. The graph fills in as the session runs.</Text>

  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const chosen = (selected && byId.get(selected)) || lines[lines.length - 1]!.node
  const detail = (
    <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text wrap="wrap">{describe(chosen)}</Text>
    </Box>
  )

  const picker =
    'Select' in els
      ? (() => {
          const { Select } = els as Elements['desktop']
          return (
            <Select
              key="node"
              label="Node"
              value={chosen.id}
              options={lines.slice(-200).map(l => ({
                value: l.id,
                label: `${'  '.repeat(l.depth)}${STATUS_MARK[l.node.status]} ${l.node.label}`.slice(0, 120),
              }))}
              onSelect={value => onSelect(value)}
            />
          )
        })()
      : null

  if (surface !== 'terminal' && 'Svg' in els) {
    const { Svg } = els as Elements['desktop']
    const { source, turns } = paneSvg(graph, windowTurns)
    return (
      <Box flexDirection="column" gap={1}>
        <Svg
          source={source}
          alt={`Conversation graph: ${tree.turns.length} turns, ${lines.length} nodes`}
          isInteractive
        />
        {turns < windowTurns && <Text dimColor>Showing the last {turns} turns to fit the pane.</Text>}
        {picker}
        {detail}
      </Box>
    )
  }

  const shown = lines.slice(-TREE_LINE_LIMIT)
  const room = Math.max(20, columns - 2)
  return (
    <Box flexDirection="column">
      {(tree.collapsed > 0 || shown.length < lines.length) && (
        <Text dimColor>
          {tree.collapsed > 0 ? `${tree.collapsed} earlier turns collapsed` : `${lines.length - shown.length} earlier lines hidden`}
        </Text>
      )}
      {shown.map(l => {
        const dur = formatDuration(l.node)
        const indent = '  '.repeat(l.depth)
        const label = `${indent}${l.node.kind === 'turn' ? '▶ ' : ''}${l.node.label}`
        const tail = dur ? ` ${dur}` : ''
        const cut = label.length + tail.length + 2 > room ? `${label.slice(0, Math.max(4, room - tail.length - 3))}…` : label
        return (
          <Box key={l.id} flexDirection="row">
            <Text color={COLOR[l.node.status]}>{STATUS_MARK[l.node.status]} </Text>
            <Text bold={l.node.kind === 'turn'} dimColor={l.node.kind === 'reasoning'} inverse={l.id === chosen.id}>
              {cut}
            </Text>
            {tail && <Text dimColor>{tail}</Text>}
          </Box>
        )
      })}
      {picker}
      {detail}
    </Box>
  )
}
