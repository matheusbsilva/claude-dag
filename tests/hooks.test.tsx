import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ROOT, graphOf, install, saved, start } from './harness'
import type { Harness } from './harness'

const step = async ($: Engine, turnId: string, index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId, index, model: 'm', messageCount: 1, agentId })
  for await (const _ of stream) void _
  return stream.result
}

const PANE_PROPS = {
  title: 'Conversation DAG',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const PRESENTATION = { isFullscreen: false, columns: 80 }
const dag = ($: Engine, args: string) =>
  $.command.run({ command: 'dag', args, origin: { kind: 'composer' }, presentation: PRESENTATION } as never)

/** A turn with two parallel tools, a denied one, a failing one, and a subagent. */
const playTurn = async ($: Engine, h: Harness) => {
  await $.turn.start({ text: 'do things\nsecond line', turnId: 't1' })
  await step($, 't1', 0)
  await Promise.all([
    $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/a' } as never),
    $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/b' } as never),
  ])
  await $.tool.call({ tool: 'Denied', tool_use_id: 'u3' } as never)
  await $.tool.call({ tool: 'Broken', tool_use_id: 'u4' } as never)
  await step($, 't1', 1)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'u5', description: 'look', prompt: 'p' } as never)
  await $.agent.spawn({
    tool_use_id: 'u5',
    prompt: 'p',
    description: 'look around',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'm',
    background: false,
    fork: false,
  } as never)
  await step($, 'sub-turn', 0, 'sub-1')
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u6', agentId: 'sub-1', pattern: 'x' } as never)
  await $.turn.complete({ answer: 'found', durationMs: 1, isAborted: false, turnId: 'sub-turn', agentId: 'sub-1', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'all done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  }

test('capture: turns, steps, parallel tools, statuses and a subagent', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never)
  await playTurn($, h)

  const g = await saved(h)
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  expect(byId.get('turn:t1')?.label).toBe('do things')
  expect(byId.get('turn:t1')?.result).toBe('all done')
  expect(byId.get('tool:u1')?.status).toBe('ok')
  expect(byId.get('tool:u3')?.status).toBe('denied')
  expect(byId.get('tool:u4')?.status).toBe('error')
  expect(byId.get('agent:sub-1')?.label).toBe('Explore: look around')
  expect(g.edges).toContainEqual({ from: 'step:t1:0', to: 'tool:u1', kind: 'contains' })
  expect(g.edges).toContainEqual({ from: 'step:t1:0', to: 'tool:u2', kind: 'contains' })
  expect(g.edges).toContainEqual({ from: 'tool:u5', to: 'agent:sub-1', kind: 'spawns' })
  expect(g.edges).toContainEqual({ from: 'step:sub-turn:0', to: 'tool:u6', kind: 'contains' })
  expect(g.edges).toContainEqual({ from: 'agent:sub-1', to: 'step:sub-turn:0', kind: 'contains' })
})

test('response text blocks become reasoning nodes under the current step', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($, 't1', 0)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hello there' }] },
    door: 'response',
    origin: { kind: 'model', model: 'm' },
    uuid: 'row-1',
  } as never)
  const g = await saved(h)
  const blocks = g.nodes.filter(n => n.kind === 'reasoning').map(n => n.label)
  expect(blocks).toEqual(['thinking', 'Hello there'])
  expect(g.edges).toContainEqual({ from: 'step:t1:0', to: 'blk:row-1:1', kind: 'contains' })
})

test('excluded tools are not captured', { options: { excludedTools: 'Bash, Glob' } }, async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' } as never)
  const g = await saved(h)
  expect(g.nodes.map(n => n.id)).toEqual(['turn:t1', 'tool:r1'])
})

test('/dag off stops capture and survives a resume; /dag on backfills from the transcript', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  h.panes.add('dag')
  expect((await dag($, 'off')).text).toContain('off')
  expect(h.panes.has('dag')).toBe(false)
  await $.turn.start({ text: 'while off', turnId: 't1' })
  expect((await saved(h)).nodes).toHaveLength(0)
  expect((await saved(h)).enabled).toBe(false)

  h.transcript.push(
    { role: 'user', content: 'while off' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'a b' }] },
  )
  expect((await dag($, 'on')).text).toContain('on')
  const g = await saved(h)
  expect(g.enabled).toBe(true)
  expect(g.nodes.map(n => n.id)).toEqual(['turn:r0', 'step:r0:0', 'tool:x1'])
})

test('a resumed session keeps its saved graph and its toggle', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await playTurn($, h)
  await dag($, 'off')
  const before = await saved(h)

  // Another session runs in this process, then the first is resumed: its file is reloaded.
  h.sessionId = 'other'
  await start(h, $, 'startup')
  await $.turn.start({ text: 'elsewhere', turnId: 'o1' })
  await saved(h)
  h.sessionId = h.mainId
  await start(h, $, 'resume')
  await $.turn.start({ text: 'ignored while off', turnId: 't2' })
  const after = await saved(h)
  expect(after.enabled).toBe(false)
  expect(after.nodes).toHaveLength(before.nodes.length)
  await dag($, 'on')
  await $.turn.start({ text: 'back on', turnId: 't3' })
  expect((await saved(h)).nodes.some(n => n.id === 'turn:t3')).toBe(true)
})

test('a resumed session with no file is rebuilt from the transcript; a fork too', async ($, on) => {
  const h = await install($, on)
  h.sessionId = 'old'
  h.transcript.push({ role: 'user', content: 'parent prompt' }, { role: 'assistant', content: 'answer' })
  await start(h, $, 'resume')
  expect((await saved(h)).nodes.map(n => n.kind)).toEqual(['turn', 'step', 'reasoning'])

  h.sessionId = 'forked'
  await start(h, $, 'fork')
  const forked = await saved(h)
  expect(forked.sessionId).toBe('forked')
  expect(forked.nodes.map(n => n.kind)).toEqual(['turn', 'step', 'reasoning'])
})

test('/clear starts an empty graph that keeps drawing', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await playTurn($, h)
  await $.session.end({ reason: 'clear' } as never)
  h.sessionId = 'sess-clear'
  await start(h, $, 'clear')
  await $.turn.start({ text: 'after clear', turnId: 'c1' })
  const cleared = await saved(h)
  expect(cleared.nodes.map(n => n.id)).toEqual(['turn:c1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dag', surface, component: 'Pane', requestId: 'dag', props: PANE_PROPS as never })
    expect((await ui.drawn()) && JSON.stringify(await ui.drawn())).toContain('after clear')
    await ui.unmount()
  }
  // The cleared session's graph was saved before it ended.
  expect(graphOf(h, h.mainId)?.nodes.length).toBeGreaterThan(5)
})

test('session.end writes the latest graph at once', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await $.turn.start({ text: 'quick', turnId: 'q1' })
  await $.session.end({ reason: 'other' } as never)
  expect(graphOf(h)?.nodes).toHaveLength(1)
})

test('/dag export writes json and svg, and explains a missing png converter', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await playTurn($, h)
  expect((await dag($, 'export json')).text).toContain('.json')
  expect((await dag($, 'export svg')).text).toContain('.svg')
  await h.clock.advance(1000)
  expect((await dag($, 'export png')).text).toContain('No PNG converter')
  expect((await dag($, 'export gif')).text).toContain('Usage')
  const exports = [...h.files.keys()].filter(p => p.startsWith(`${ROOT}/.claude/dag/exports/${h.mainId}-`))
  expect(exports.filter(p => p.endsWith('.json'))).toHaveLength(1)
  expect(exports.filter(p => p.endsWith('.svg'))).toHaveLength(2)
  const json = JSON.parse(h.files.get(exports.find(p => p.endsWith('.json'))!)!)
  expect(json.schemaVersion).toBe(1)
  expect(h.files.get(exports.find(p => p.endsWith('.svg'))!)).toStartWith('<svg')
})

test('/dag opens and closes the pane', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  expect((await dag($, '')).text).toContain('opened')
  expect(h.panes.has('dag')).toBe(true)
  expect((await dag($, '')).text).toContain('closed')
  expect(h.panes.has('dag')).toBe(false)
})


test('the pane draws on both surfaces and picks a node for details', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  await playTurn($, h)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dag', surface, component: 'Pane', requestId: 'dag', props: PANE_PROPS as never })
    if (surface === 'desktop') {
      const svg = await ui.find({ type: 'Svg' })
      expect(String(svg?.props.source)).toContain('do things')
    } else {
      expect(await ui.find({ text: /do things/ })).toBeDefined()
      expect(await ui.find({ text: /Grep/ })).toBeDefined()
    }
    await ui.select({ key: 'node', value: 'tool:u4' })
    expect((await ui.find({ key: 'detail' }))?.text).toContain('Broken')
    await ui.unmount()
  }
})

test('the pane says when there is nothing to draw, or capture is off', async ($, on) => {
  const h = await install($, on)
  await start(h, $, 'startup')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dag', surface, component: 'Pane', requestId: 'dag', props: PANE_PROPS as never })
    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    await ui.unmount()
  }
  await dag($, 'off')
  const ui = await $.ui.mount({ plugin: 'dag', surface: 'terminal', component: 'Pane', requestId: 'dag', props: PANE_PROPS as never })
  expect(await ui.find({ text: /capture is off/ })).toBeDefined()
})
