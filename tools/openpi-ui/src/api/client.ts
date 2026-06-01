import { DatasetInfo, ConfigInfo, GpuSnapshot, GripperApplyResult, GripperMode, GripperStats, JobRecord, NormStatsDetail, NormStatsJobRequest, NormStatsList, NormStatsOverrides, NormStatsPatchResult, TrainJobRequest } from './types';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getDatasets: () => fetchJson<DatasetInfo[]>('/api/datasets'),
  getConfigs: () => fetchJson<ConfigInfo[]>('/api/configs'),
  getJobs: () => fetchJson<JobRecord[]>('/api/jobs'),
  getGpu: () => fetchJson<GpuSnapshot>('/api/gpu'),
  getWandbSecret: () => fetchJson<{ hasKey: boolean; maskedKey: string | null }>('/api/secrets/wandb'),
  saveWandbSecret: (key: string) =>
    fetchJson<{ hasKey: boolean; maskedKey: string | null }>('/api/secrets/wandb', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  clearWandbSecret: () =>
    fetchJson<{ hasKey: boolean; maskedKey: string | null }>('/api/secrets/wandb', { method: 'DELETE' }),
  getPreCommand: () => fetchJson<{ preCommand: string }>('/api/settings/pre-command'),
  savePreCommand: (preCommand: string) =>
    fetchJson<{ preCommand: string }>('/api/settings/pre-command', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preCommand }),
    }),
  resetPreCommand: () =>
    fetchJson<{ preCommand: string }>('/api/settings/pre-command', { method: 'DELETE' }),
  getGripperStats: (user: string, name: string, gripperIdx?: number) =>
    fetchJson<GripperStats>(
      `/api/datasets/${encodeURIComponent(user)}/${encodeURIComponent(name)}/gripper-stats${
        gripperIdx !== undefined ? `?gripperIdx=${gripperIdx}` : ''
      }`,
    ),
  normalizeGripper: (
    user: string,
    name: string,
    body: { mode: GripperMode; params: Record<string, number>; gripperIdx?: number; backup?: boolean },
  ) =>
    fetchJson<GripperApplyResult>(
      `/api/datasets/${encodeURIComponent(user)}/${encodeURIComponent(name)}/normalize-gripper`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  killJob: (id: string) => fetchJson<JobRecord>(`/api/jobs/${id}/kill`, { method: 'POST' }),
  launchNormStats: (req: NormStatsJobRequest) =>
    fetchJson<JobRecord>('/api/jobs/norm-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
  launchTrain: (req: TrainJobRequest) =>
    fetchJson<JobRecord>('/api/jobs/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
  listNormStats: (user: string, name: string) =>
    fetchJson<NormStatsList>(
      `/api/datasets/${encodeURIComponent(user)}/${encodeURIComponent(name)}/norm-stats`,
    ),
  getNormStats: (path: string) =>
    fetchJson<NormStatsDetail>(`/api/norm-stats?path=${encodeURIComponent(path)}`),
  patchNormStats: (body: { path: string; overrides: NormStatsOverrides; backup?: boolean }) =>
    fetchJson<NormStatsPatchResult>('/api/norm-stats', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

export function openLogSocket(
  jobId: string,
  handlers: {
    onData: (data: string) => void;
    onStatus: (status: string, exitCode?: number) => void;
    onEnd: () => void;
  }
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/jobs/${jobId}/log`;
  let ws = new WebSocket(url);
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'data') handlers.onData(msg.data);
      else if (msg.type === 'status') handlers.onStatus(msg.status, msg.exitCode);
      else if (msg.type === 'end') handlers.onEnd();
    } catch (e) {
      console.error('Invalid log message', e);
    }
  };

  return ws;
}
