export type AgentRole = 'watcher' | 'helper'

/** One subagent as the panel draws it. */
export type AgentRow = {
  id: string
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  /** What it is doing now: its in-flight tool call, else its last line of text. */
  activity: string
  parentId?: string
  role?: AgentRole
  /** The model it runs on, as its spawn resolved it (absent for one spawned before the mod loaded). */
  model?: string
  /** What kind of job it is doing, read from its type, description and the tools it used. */
  job?: 'lookup' | 'coding' | 'reasoning'
  /** The one cheaper model the panel offers for it, absent when it already runs on the cheapest that suits. */
  suggestion?: Suggestion
}

/** A cheaper model for a kind of subagent: what the row's button offers. */
export type Suggestion = {
  /** The model's id, what a spawn runs on (`claude-haiku-5-5`). */
  id: string
  /** `Haiku 5.5` */
  label: string
  /** Its price against the model the subagent runs on: `$0.10/$0.50, 98% less`. */
  detail: string
  /** The kind of subagent a click sets it for: its type and the job its spawn reads as (`Explore:lookup`). */
  kind: string
  /** That kind in words: `Explore lookup jobs`. */
  kindLabel: string
}

export type HelperRow = {
  /** Unique per spawn_helper call: what the queue and the state row are matched by. */
  key: string
  /** Absent while queued. */
  id?: string
  description: string
  status: 'queued' | 'running' | 'done' | 'failed'
}

export type Boost = {
  status: 'off' | 'starting' | 'watching' | 'stopping'
  watcherId: string | null
  helpers: HelperRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-boost': { agents: AgentRow[]; boost: Boost; models: Record<string, string>; blink: boolean; prefs: Record<string, string> }
  }
}
