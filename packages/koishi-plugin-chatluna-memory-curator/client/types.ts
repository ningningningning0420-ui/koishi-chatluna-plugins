export interface EntityRow { entity: string; qq: string; aliases: string; favor: string; factCount: number }
export interface PersonDetail { entity: string; qq: string; profile: Record<string, string>; facts: any[] }
export interface Stats { people: number; profiles: number; facts: number }
declare module '@koishijs/client' {
  interface Events {
    'memory-curator/listEntities': (q: { search?: string }) => EntityRow[]
    'memory-curator/getPerson': (q: { entity: string }) => PersonDetail
    'memory-curator/stats': () => Stats
  }
}
