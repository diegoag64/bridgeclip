import { create } from 'zustand'
import type { EnhancementJob } from '../../shared/automations'
import { getApi } from '../lib/ipc'
import { useDataVersionStore } from './use-data-version-store'

interface EnhancementState {
  jobs: EnhancementJob[]
  connectionError: string | null
  refresh: () => Promise<void>
  start: (id: string, key: string, guidance: string) => Promise<void>
  control: (id: string, action: 'stop' | 'dismiss') => Promise<void>
}
let requestVersion = 0
export const useEnhancementStore = create<EnhancementState>((set, get) => ({
  jobs: [], connectionError: null,
  refresh: async () => {
    const version = ++requestVersion
    try {
      const jobs = await getApi().automations.enhancementJobs()
      if (version !== requestVersion) return
      if (jobs.some(job => {
        const old = get().jobs.find(item => item.id === job.id)
        return job.processed !== old?.processed || job.status !== old?.status
      })) useDataVersionStore.getState().bump('automations')
      set({ jobs, connectionError: null })
    } catch {
      if (version === requestVersion) set({ connectionError: 'Progress could not be refreshed. Reconnecting…' })
    }
  },
  start: async (id, key, guidance) => {
    ++requestVersion
    const job = await getApi().automations.startEnhancement(id, key, guidance)
    ++requestVersion
    set({ jobs: [...get().jobs.filter(item => item.automationId !== id), job], connectionError: null })
  },
  control: async (id, action) => {
    ++requestVersion
    const jobs = await getApi().automations.controlEnhancement(id, action)
    ++requestVersion
    set({ jobs })
  }
}))
