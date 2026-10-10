import type { DagFile, DagStatus, DagUsage } from '../types'

export const MAIN = 'main'

/** The normalised inputs the reducer takes; each collector hook builds one. */
export type DagEvent =
  | { type: 'turnStart'; turnId: string; text: string; at: number }
  | { type: 'stepStart'; turnId: string; index: number; agentId?: string; model: string; at: number }
  | { type: 'stepEnd'; turnId: string; index: number; agentId?: string; usage?: DagUsage; at: number }
  | { type: 'block'; uuid: string; agentId?: string; kind: 'text' | 'thinking'; text: string; at: number }
  | { type: 'toolStart'; toolUseId: string; tool: string; agentId?: string; input: string; at: number }
  | { type: 'toolEnd'; toolUseId: string; status: DagStatus; result: string; at: number }
  | {
      type: 'spawned'
      toolUseId: string
      agentId: string
      subagentType: string
      description: string
      parentAgentId?: string
      at: number
    }
  | {
      type: 'turnEnd'
      turnId: string
      agentId?: string
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      answer: string
      usage?: DagUsage
      at: number
    }

export const emptyGraph = (sessionId: string, at: number, enabled = true): DagFile => ({
  schemaVersion: 1,
  sessionId,
  enabled,
  nodes: [],
  edges: [],
  updatedAt: at,
  cursors: {},
})

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

export const firstLine = (text: string, max = 60): string =>
  clip(text.trim().split('\n', 1)[0] ?? '', max)

export const turnNodeId = (turnId: string) => `turn:${turnId}`
export const stepNodeId = (turnId: string, index: number) => `step:${turnId}:${index}`
export const toolNodeId = (toolUseId: string) => `tool:${toolUseId}`
export const agentNodeId = (agentId: string) => `agent:${agentId}`
export const blockNodeId = (uuid: string) => `blk:${uuid}`
