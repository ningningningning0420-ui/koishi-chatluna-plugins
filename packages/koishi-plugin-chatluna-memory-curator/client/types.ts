export interface EntityRow { entity: string; qq: string; aliases: string; favor: string; factCount: number }
export interface FactRow { id: string; content: string; importance: number | null; status: string; lastAccessedAt: number | null; updatedAt: number }
export interface PersonDetail { entity: string; qq: string; profile: Record<string, string>; facts: FactRow[] }
export interface Stats { people: number; profiles: number; facts: number }
declare module '@koishijs/client' {
  interface Events {
    'memory-curator/listEntities': (q: { search?: string }) => EntityRow[]
    'memory-curator/getPerson': (q: { entity: string }) => PersonDetail
    'memory-curator/stats': () => Stats
    'memory-curator/setProfile': (q: { entity: string; patch: Record<string, string> }) => { ok: boolean }
    'memory-curator/createPerson': (q: { entity: string; patch: Record<string, string> }) => { ok: boolean }
    'memory-curator/remember': (q: { entity: string; content: string; importance?: number }) => { ok: boolean }
    'memory-curator/updateFact': (q: { id: string; content?: string; importance?: number }) => { ok: boolean }
    'memory-curator/forget': (q: { id: string }) => { ok: boolean }
    'memory-curator/restore': (q: { id: string }) => { ok: boolean }
  }
}
