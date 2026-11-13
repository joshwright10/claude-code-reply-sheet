export type IsDrafting = boolean
export type IsBuilding = boolean
// rev bumps after Enter so the field redraws with its saved text (Input empties itself on submit).
export type FormItem = { body: string; response: string; rev: number }
export type Form = { file: string; items: FormItem[]; general: string; generalRev: number }

declare module 'claude-code' {
  interface PluginState {
    'reply-sheet': { isDrafting: IsDrafting; isBuilding: IsBuilding; form: Shaped<Form | null>; warning: string | null }
  }
}
