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
  sizeBytes?: number;
  hasInfoJson: boolean;
  lastModifiedMs: number;
}

export interface ConfigInfo {
  name: string;
  modelType?: string;
  defaultRepoId?: string;
  numTrainSteps?: number;
  batchSize?: number;
}

export type JobKind = 'norm-stats' | 'train';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed';

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  command: string;
  logFile: string;
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
  exitCode?: number;
  pid?: number;
  pgid?: number;
  autoRestartCount?: number;
  autoRestartReason?: string;
  request: unknown;
}

export interface NormStatsJobRequest {
  configName: string;
  repoId?: string;
  maxFrames?: number;
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

export interface GripperChannelStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  median: number;
  count: number;
  unique_count: number;
  unique_preview: number[];
}

export interface GripperStats {
  datasetDir: string;
  fileCount: number;
  dims: Record<string, number | null>;
  gripperIdx: number;
  stats: Record<string, GripperChannelStats>;
}

export type GripperMode = "threshold-binary" | "minmax-01" | "divide";

export interface GripperApplyResult {
  ok: boolean;
  datasetDir: string;
  backupPath: string | null;
  filesProcessed: number;
  filesChanged: number;
  gripperIdx: number;
  mode: GripperMode;
  params: Record<string, number>;
}

export interface NormStatsFile {
  configName: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface NormStatsList {
  user: string;
  dataset: string;
  files: NormStatsFile[];
}

export interface NormStatsEntry {
  mean: number[];
  std: number[];
  q01: number[] | null;
  q99: number[] | null;
}

export interface NormStatsDimDiag {
  dim: number;
  std?: number;
  stdNearZero?: boolean;
  q01?: number;
  q99?: number;
  span?: number;
  spanNearZero?: boolean;
}

export interface NormStatsDetail {
  path: string;
  mtimeMs: number;
  stats: Record<string, NormStatsEntry>;
  diagnostics: Record<string, NormStatsDimDiag[]>;
}

export type NormStatsField = "mean" | "std" | "q01" | "q99";

export type NormStatsOverrides = Record<
  string,
  Partial<Record<NormStatsField, { dims: Record<string, number> }>>
>;

export interface NormStatsPatchResult {
  ok: boolean;
  path: string;
  backupPath: string | null;
  changedDims: Array<{ key: string; field: NormStatsField; dim: number; value: number }>;
}
