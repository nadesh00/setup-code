/** One past conversation as the panel lists it. */
export type Conversation = {
  /** What `/resume` takes. */
  id: string
  title: string
  /** Where the title came from: the person's /rename, the engine's own, or this mod's model call. */
  titleSource: 'custom' | 'ai' | 'generated' | 'prompt'
  /** The transcript's last write, ms since the epoch. */
  updatedAt: number
  /** Prompts the person typed in it. */
  prompts: number
}

export type Listing = {
  status: 'idle' | 'loading' | 'error'
  conversations: Conversation[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    conversations: { listing: Listing; resuming: string | null }
  }
}
