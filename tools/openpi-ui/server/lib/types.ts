export type JobKind = "norm-stats" | "train" | "infer";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "killed";

export interface DatasetInfo {
  repoId: string;
  user: string;
  dataset: string;
  totalEpisodes?: number;
  totalFrames?: number;
  totalVideos?: number;
  fps?: number;
  robotType?: string;
  taskPrompts?: string[];
  codebaseVersion?: string;
  sizeBytes?: number;
  hasInfoJson: boolean;
  lastModifiedMs: number;
}

export interface DatasetMergeRequest {
  sourceRepoIds: string[];
  targetRepoId: string;
  overwrite?: boolean;
}

export interface DatasetMergeResult {
  ok: boolean;
  targetRepoId: string;
  targetDir: string;
  sourceRepoIds: string[];
  episodesMerged: number;
  framesMerged: number;
  tasksMerged: number;
  filesCopied: number;
}

export interface ConfigInfo {
  name: string;
  modelType?: string;
  defaultRepoId?: string | null;
  numTrainSteps?: number;
  batchSize?: number;
}

export interface TrainJobRequest {
  configName: string;
  expName: string;
  repoId?: string;
  numTrainSteps?: number;
  seed?: number;
  batchSize?: number;
  logInterval?: number;
  saveInterval?: number;
  overwrite?: boolean;
  resume?: boolean;
  wandbEnabled?: boolean;
  wandbApiKey?: string;
  cudaVisibleDevices?: string;
  xlaMemFraction?: number;
  keepPeriod?: number;
  targetHostId?: string;
  syncDataset?: boolean;
  assetId?: string;
  usePytorch?: boolean;
  pytorchTrainingPrecision?: 'bfloat16' | 'float32';
  resumeStep?: number;
  checkpointSource?: 'local' | 'remote';
  checkpointHostId?: string;
  checkpointRunRelativePath?: string;
}

export interface RemoteHost {
  id: string;
  label: string;
  sshTarget: string;
  sshArgs?: string[];
  repoRoot: string;
  datasetRoot?: string;
  checkpointRoot?: string;
  containerName?: string;
}

export interface RemoteCheckpointInfo {
  hostId: string;
  hostLabel: string;
  relativePath: string;
  remotePath: string;
  mtimeMs: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  memoryTotalMib: number;
  memoryUsedMib: number;
  memoryFreeMib: number;
  utilizationPct: number;
  temperatureC: number;
}

export interface GpuProcInfo {
  gpuIndex: number;
  pid: number;
  processName: string;
  memoryUsedMib: number;
  user?: string;
  cmd?: string;
}

export interface GpuSnapshot {
  available: boolean;
  error?: string;
  gpus: GpuInfo[];
  processes: GpuProcInfo[];
  at: number;
}

export interface NormStatsJobRequest {
  configName: string;
  repoId?: string;
  maxFrames?: number;
}

export interface InferJobRequest {
  configName: string;
  checkpointDir: string;
  prompt: string;
  bind?: string;
  backend?: "jax" | "torch";
  cudaVisibleDevices?: string;
  chunkSize?: number;
  maxJointStepDeg?: number;
  missingImage?: "error" | "zeros";
  repoId?: string;
  condaEnv?: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  command: string;
  logFile: string;
  containerName: string;
  configName: string;
  expName?: string;
  repoId?: string;
  assetId?: string;
  targetHostId?: string;
  targetLabel?: string;
  remoteLogFile?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  pid?: number | null;
  pgid?: number | null;
  autoRestartCount?: number;
  autoRestartReason?: string;
  request: TrainJobRequest | NormStatsJobRequest | InferJobRequest;
}
