import { expect, test } from 'claude-code/testing'

import { flatten, layout, visibleTree } from '../hooks/layout'
import { SVG_LIMIT, paneSvg } from '../hooks/pane'
import { FILE_BUDGET, serializeWithin } from '../hooks/persist'
import { toSvg } from '../hooks/svg'

import { syntheticGraph } from './fixtures/synthetic'

test('the window keeps the last N turns and counts the rest', () => {
  const g = syntheticGraph(25, 2, 1)
  const tree = visibleTree(g, 10)
  expect(tree.collapsed).toBe(15)
  expect(tree.turns).toHaveLength(10)
  expect(tree.turns[0]!.node.label).toStartWith('prompt 15')
  expect(visibleTree(g, 0).turns).toHaveLength(25)
  // turn, 2 steps, 1 tool each
  expect(flatten(tree)).toHaveLength(10 * 5)
})

test('steps run left to right and their tools stack under them', () => {
  const g = syntheticGraph(2, 2, 2)
  const lay = layout(g, visibleTree(g, 10))
  const at = (id: string) => lay.boxes.find(b => b.id === id)!
  expect(at('step:t0:1').y).toBe(at('step:t0:0').y)
  expect(at('step:t0:1').x).toBeGreaterThan(at('step:t0:0').x)
  expect(at('tool:0-0-1').y).toBeGreaterThan(at('tool:0-0-0').y)
  expect(at('tool:0-0-0').x).toBeGreaterThan(at('step:t0:0').x)
  expect(at('turn:t1').y).toBeGreaterThan(at('tool:0-0-1').y)
  expect(lay.lines.some(l => l.from === 'turn:t0' && l.to === 'turn:t1')).toBe(true)
})

test('a 2,000-turn session keeps the pane under the Svg cap', () => {
  const g = syntheticGraph(2000, 3, 3)
  // Truncated details keep the graph linear in the session's length.
  expect(JSON.stringify(g).length / 2000).toBeLessThan(15_000)
  const { source, turns } = paneSvg(g, 10)
  expect(source.length).toBeLessThanOrEqual(SVG_LIMIT)
  expect(turns).toBeGreaterThan(0)
  // The export draws everything.
  expect(toSvg(layout(g, visibleTree(g, 0)), { titles: false }).length).toBeGreaterThan(SVG_LIMIT)
})

test('svg escapes what the model wrote', () => {
  const g = syntheticGraph(1, 1, 1)
  const evil = { ...g, nodes: g.nodes.map(n => (n.kind === 'tool' ? { ...n, label: '<script>&"' } : n)) }
  const svg = toSvg(layout(evil, visibleTree(evil, 10)), { titles: true })
  expect(svg).not.toContain('<script>')
  expect(svg).toContain('&lt;script&gt;&amp;&quot;')
})

test('the saved file fits 4 MiB however long the session', () => {
  const g = syntheticGraph(2000, 3, 3)
  expect(JSON.stringify(g).length).toBeGreaterThan(FILE_BUDGET)
  const { text, graph } = serializeWithin(g, FILE_BUDGET, 10)
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(FILE_BUDGET)
  // Recent turns keep their details; the pane counts what was dropped.
  const last = graph.nodes.filter(n => n.kind === 'turn').at(-1)!
  expect(last.detail).toBeDefined()
  expect(visibleTree(graph, 10).collapsed + 10).toBe(2000)

  const small = syntheticGraph(3, 1, 1)
  expect(serializeWithin(small, FILE_BUDGET, 10).graph).toBe(small)
})
