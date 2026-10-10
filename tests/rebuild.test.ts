import { expect, test } from 'claude-code/testing'

import { mergeLive, rebuild } from '../hooks/rebuild'
import type { ApiRow } from '../hooks/rebuild'

const OPTS = { maxDetailChars: 500 }

const ROWS: ApiRow[] = [
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }, { type: 'text', text: 'read both files' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a' } },
      { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'b' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'r1', content: 'hello' },
      { type: 'tool_result', tool_use_id: 'r2', content: [{ type: 'text', text: 'nope' }], is_error: true },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  { role: 'user', content: '<command-name>/dag</command-name>' },
  { role: 'user', content: 'second prompt' },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
]

test('rebuild: turns, steps and parallel tools from the API-shaped transcript', () => {
  const g = rebuild(ROWS, 'sess', 100, OPTS)
  const turns = g.nodes.filter(n => n.kind === 'turn')
  expect(turns.map(t => t.label)).toEqual(['read both files', 'second prompt'])
  expect(g.edges).toContainEqual({ from: 'turn:r0', to: 'turn:r1', kind: 'sequence' })
  const step = g.edges.filter(e => e.from === 'step:r0:0' && e.kind === 'contains').map(e => e.to)
  expect(step).toEqual([expect.stringMatching(/^blk:/), 'tool:r1', 'tool:r2'])
  expect(g.nodes.find(n => n.id === 'tool:r1')!.result).toBe('hello')
  expect(g.nodes.find(n => n.id === 'tool:r2')!.status).toBe('error')
  expect(g.nodes.every(n => n.status !== 'running')).toBe(true)
  expect(g.lastTurnId).toBe('turn:r1')
})

test('mergeLive keeps live timings and subagent loops', () => {
  const rebuilt = rebuild(ROWS, 'sess', 100, OPTS)
  const live = {
    ...rebuilt,
    nodes: [
      { id: 'tool:r1', kind: 'tool' as const, label: 'Read', status: 'ok' as const, startedAt: 5, endedAt: 9, toolUseId: 'r1' },
      { id: 'agent:x', kind: 'subagent' as const, label: 'sub', status: 'ok' as const, startedAt: 6, agentId: 'x' },
    ],
    edges: [{ from: 'tool:r1', to: 'agent:x', kind: 'spawns' as const }],
  }
  const g = mergeLive(rebuilt, live)
  expect(g.nodes.find(n => n.id === 'tool:r1')!.endedAt).toBe(9)
  expect(g.nodes.find(n => n.id === 'agent:x')).toBeDefined()
  expect(g.edges).toContainEqual({ from: 'tool:r1', to: 'agent:x', kind: 'spawns' })
})
