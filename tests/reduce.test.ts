import { describe, expect, test } from 'claude-code/testing'

import { emptyGraph } from '../hooks/model'
import type { DagEvent } from '../hooks/model'
import { reduce } from '../hooks/reduce'
import type { DagFile } from '../types'

import { parallelAndSubagent } from './fixtures/parallel-and-subagent'
import { thinking } from './fixtures/thinking'

const OPTS = { maxDetailChars: 500 }
const replay = (events: DagEvent[], g: DagFile = emptyGraph('s', 0)) => events.reduce((acc, ev) => reduce(acc, ev, OPTS), g)
const node = (g: DagFile, id: string) => g.nodes.find(n => n.id === id)
const childrenOf = (g: DagFile, id: string, kind = 'contains') =>
  g.edges.filter(e => e.from === id && e.kind === kind).map(e => node(g, e.to)!)

describe('reduce: recorded session with parallel tools and a subagent', () => {
  const g = replay(parallelAndSubagent)
  const turn = g.nodes.find(n => n.kind === 'turn')!

  test('one turn with three steps in sequence', () => {
    expect(g.nodes.filter(n => n.kind === 'turn')).toHaveLength(1)
    const steps = childrenOf(g, turn.id)
    expect(steps.map(s => s.label)).toEqual(['step 1', 'step 2', 'step 3'])
    expect(g.edges.filter(e => e.kind === 'sequence' && steps.some(s => s.id === e.to))).toHaveLength(2)
    expect(turn.status).toBe('ok')
    expect(turn.endedAt).toBeDefined()
  })

  test('parallel tool calls of one step are siblings', () => {
    const first = childrenOf(g, turn.id)[0]!
    expect(childrenOf(g, first.id).map(n => n.label)).toEqual(['Read', 'Read', 'Bash'])
    expect(childrenOf(g, first.id).every(n => n.status === 'ok' && n.endedAt !== undefined)).toBe(true)
  })

  test('the subagent hangs from the Agent tool and holds its own steps and tools', () => {
    const agentTool = g.nodes.find(n => n.label === 'Agent')!
    const [sub] = childrenOf(g, agentTool.id, 'spawns')
    expect(sub?.kind).toBe('subagent')
    expect(sub?.label).toStartWith('general-purpose:')
    expect(sub?.status).toBe('ok')
    const subSteps = childrenOf(g, sub!.id)
    expect(subSteps).toHaveLength(2)
    expect(childrenOf(g, subSteps[0]!.id).map(n => n.label)).toEqual(['Bash'])
    expect(childrenOf(g, subSteps[0]!.id)[0]!.agentId).toBe(sub!.agentId)
  })

  test('the final text is a reasoning node under the last step', () => {
    const last = childrenOf(g, turn.id)[2]!
    expect(childrenOf(g, last.id).map(n => n.kind)).toEqual(['reasoning'])
  })

  test('replaying an event twice adds nothing', () => {
    const again = replay(parallelAndSubagent, g)
    expect(again.nodes).toHaveLength(g.nodes.length)
    expect(again.edges).toHaveLength(g.edges.length)
  })
})

test('reduce: thinking arrives without text and shows as hidden', () => {
  const g = replay(thinking)
  const blocks = g.nodes.filter(n => n.kind === 'reasoning')
  expect(blocks.map(b => b.label)).toEqual(['thinking', '(recorded)'])
  expect(blocks[0]!.detail).toBe('thinking (hidden)')
})

test('reduce: denied and failed tools, interrupted turns', () => {
  const g = replay([
    { type: 'turnStart', turnId: 't', text: 'go', at: 1 },
    { type: 'stepStart', turnId: 't', index: 0, model: 'm', at: 2 },
    { type: 'toolStart', toolUseId: 'a', tool: 'Bash', input: '{}', at: 3 },
    { type: 'toolStart', toolUseId: 'b', tool: 'Edit', input: '{}', at: 3 },
    { type: 'toolStart', toolUseId: 'c', tool: 'Read', input: '{}', at: 3 },
    { type: 'toolEnd', toolUseId: 'a', status: 'error', result: 'boom', at: 4 },
    { type: 'toolEnd', toolUseId: 'b', status: 'denied', result: 'no', at: 4 },
    { type: 'turnEnd', turnId: 't', reason: 'aborted', answer: '', at: 9 },
  ])
  expect(node(g, 'tool:a')!.status).toBe('error')
  expect(node(g, 'tool:a')!.result).toBe('boom')
  expect(node(g, 'tool:b')!.status).toBe('denied')
  // Left running when the turn was interrupted: closed with the turn.
  expect(node(g, 'tool:c')!.status).toBe('denied')
  expect(node(g, 'tool:c')!.endedAt).toBe(9)
  expect(node(g, 'turn:t')!.status).toBe('denied')
})

test('reduce: details are truncated and turns chain in sequence', () => {
  const g = reduce(
    replay([
      { type: 'turnStart', turnId: 'one', text: 'x'.repeat(50), at: 1 },
      { type: 'turnStart', turnId: 'two', text: 'second', at: 2 },
    ]),
    { type: 'toolStart', toolUseId: 'z', tool: 'Bash', input: 'y'.repeat(50), at: 3 },
    { maxDetailChars: 10 },
  )
  expect(g.edges).toContainEqual({ from: 'turn:one', to: 'turn:two', kind: 'sequence' })
  expect(node(g, 'tool:z')!.detail).toBe(`${'y'.repeat(10)}…`)
  // A tool with no current step hangs from its turn.
  expect(g.edges).toContainEqual({ from: 'turn:two', to: 'tool:z', kind: 'contains' })
})
