import { emptyGraph } from '../../hooks/model'
import type { DagEvent } from '../../hooks/model'
import { reduceAll } from '../../hooks/reduce'
import type { DagFile } from '../../types'

/** A long session: each turn has `steps` steps of `tools` parallel calls with long inputs. */
export const syntheticGraph = (turns: number, steps = 3, tools = 3, maxDetailChars = 500): DagFile => {
  const events: DagEvent[] = []
  let at = 0
  const push = (ev: DagEvent) => events.push(ev)
  for (let t = 0; t < turns; t++) {
    const turnId = `t${t}`
    push({ type: 'turnStart', turnId, text: `prompt ${t} ${'p'.repeat(2000)}`, at: at++ })
    for (let s = 0; s < steps; s++) {
      push({ type: 'stepStart', turnId, index: s, model: 'm', at: at++ })
      for (let k = 0; k < tools; k++) {
        const toolUseId = `${t}-${s}-${k}`
        push({ type: 'toolStart', toolUseId, tool: 'Bash', input: 'x'.repeat(5000), at: at++ })
        push({ type: 'toolEnd', toolUseId, status: 'ok', result: 'y'.repeat(5000), at: at++ })
      }
      push({ type: 'stepEnd', turnId, index: s, at: at++ })
    }
    push({ type: 'turnEnd', turnId, reason: 'answer', answer: 'done', at: at++ })
  }
  return reduceAll(emptyGraph('long', 0), events, { maxDetailChars })
}
