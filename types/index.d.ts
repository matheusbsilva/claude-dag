export type DagNodeKind = 'turn' | 'step' | 'reasoning' | 'tool' | 'subagent'
export type DagStatus = 'running' | 'ok' | 'error' | 'denied'
export type DagEdgeKind = 'sequence' | 'contains' | 'spawns'

export type DagUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  model?: string
}

export type DagNode = {
  id: string
  kind: DagNodeKind
  /** Tool name, step number, first line of text. */
  label: string
  status: DagStatus
  startedAt: number
  endedAt?: number
  /** Truncated to maxDetailChars. */
  detail?: string
  /** Truncated result summary of a tool call or a subagent's answer. */
  result?: string
  /** The subagent loop the node belongs to; absent on the main loop. */
  agentId?: string
  toolUseId?: string
  usage?: DagUsage
}

export type DagEdge = { from: string; to: string; kind: DagEdgeKind }

/** Where each loop ('main' or a subagent id) stands: its turn and current step. */
export type DagCursor = { turnId?: string; stepId?: string; lastStepId?: string }

export type DagFile = {
  schemaVersion: 1
  sessionId: string
  enabled: boolean
  nodes: DagNode[]
  edges: DagEdge[]
  updatedAt: number
  /** The last main-loop turn node, for the next turn's sequence edge. */
  lastTurnId?: string
  /** Oldest main-loop turns left out of the file to keep it under the size limit. */
  droppedTurns?: number
  cursors: Record<string, DagCursor>
}

declare module 'claude-code' {
  interface PluginState {
    dag: {
      graph: DagFile | null
      selected: string | null
    }
  }
}
