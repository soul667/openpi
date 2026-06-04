import { DatasetInfo, ConfigInfo, GpuSnapshot, GripperApplyResult, GripperMode, GripperStats, InferJobRequest, JobRecord, LocalCheckpointInfo, NormStatsDetail, NormStatsJobRequest, NormStatsList, NormStatsOverrides, NormStatsPatchResult, RemoteCheckpointInfo, RemoteHost, TrainJobRequest } from './types';

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
  updateDatasetPrompts: (user: string, name: string, taskPrompts: string[]) =>
    fetchJson<DatasetInfo>(`/api/datasets/${encodeURIComponent(user)}/${encodeURIComponent(name)}/prompts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskPrompts }),
    }),
  getConfigs: () => fetchJson<ConfigInfo[]>('/api/configs'),
  getJobs: () => fetchJson<JobRecord[]>('/api/jobs'),
  getGpu: () => fetchJson<GpuSnapshot>('/api/gpu'),
  getRemotes: () => fetchJson<RemoteHost[]>('/api/remotes'),
  getRemoteGpu: (id: string) => fetchJson<GpuSnapshot>(`/api/remotes/${encodeURIComponent(id)}/gpu`),
  getRemoteCheckpoints: (id: string) =>
    fetchJson<{ checkpoints: RemoteCheckpointInfo[] }>(`/api/remotes/${encodeURIComponent(id)}/checkpoints`),
  pullRemoteCheckpoint: (id: string, relativePath: string) =>
    fetchJson<{ ok: boolean; localPath: string; remotePath: string }>(
      `/api/remotes/${encodeURIComponent(id)}/checkpoints/pull`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath }),
      },
    ),
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
  getJobLog: (id: string, from: number) =>
    fetchJson<{ chunk: string; nextByte: number; eof: boolean }>(
      `/api/jobs/${encodeURIComponent(id)}/log?from=${from}`,
    ),
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
  launchInfer: (req: InferJobRequest) =>
    fetchJson<JobRecord>('/api/jobs/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
  getLocalCheckpoints: () =>
    fetchJson<{ checkpoints: LocalCheckpointInfo[] }>('/api/checkpoints/local'),
  getInferSettings: () =>
    fetchJson<{ condaEnv: string; inferPreCommand: string }>('/api/settings/infer'),
  saveInferSettings: (body: { condaEnv?: string; inferPreCommand?: string }) =>
    fetchJson<{ condaEnv: string; inferPreCommand: string }>('/api/settings/infer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  listConfigAssetNorms: (configName: string) =>
    fetchJson<{ configName: string; assets: Array<{ assetId: string; path: string; mtimeMs: number; sizeBytes: number }> }>(
      `/api/configs/${encodeURIComponent(configName)}/asset-norms`,
    ),
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
