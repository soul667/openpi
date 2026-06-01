import { create } from 'zustand';
import { JobRecord } from '../api/types';
import { api } from '../api/client';

interface JobsState {
  jobs: JobRecord[];
  activeJob: JobRecord | null;
  pendingRepoId: string | null;
  fetchJobs: () => Promise<void>;
  setPendingRepoId: (repoId: string | null) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  activeJob: null,
  pendingRepoId: null,
  fetchJobs: async () => {
    try {
      const jobs = await api.getJobs();
      const activeJob = jobs.find(j => j.status === 'queued' || j.status === 'running') || null;
      set({ jobs, activeJob });
    } catch (e) {
      console.error('Failed to fetch jobs', e);
    }
  },
  setPendingRepoId: (repoId) => set({ pendingRepoId: repoId }),
}));

// Setup polling in a module level effect-like manner
let pollingInterval: number | null = null;
export const startJobsPolling = () => {
  if (!pollingInterval) {
    useJobsStore.getState().fetchJobs();
    pollingInterval = window.setInterval(() => {
      useJobsStore.getState().fetchJobs();
    }, 3000);
  }
};
