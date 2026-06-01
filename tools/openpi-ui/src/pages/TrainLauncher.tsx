import { useEffect, useMemo, useState } from "react";
import {
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Typography,
  message,
} from "antd";
import { ThunderboltOutlined, RocketOutlined } from "@ant-design/icons";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { ConfigInfo, DatasetInfo, GpuSnapshot, JobRecord, RemoteHost } from "../api/types";
import { useJobsStore } from "../store/jobs";
import { WandbSecretCard } from "../components/WandbSecretCard";
import { PreCommandCard } from "../components/PreCommandCard";

const WANDB_KEY_STORAGE = "openpi-ui:wandb-key";

function nowStamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function TrainLauncher() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const pendingRepoId = useJobsStore((s) => s.pendingRepoId);
  const setPendingRepoId = useJobsStore((s) => s.setPendingRepoId);

  const [configs, setConfigs] = useState<ConfigInfo[]>([]);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [remotes, setRemotes] = useState<RemoteHost[]>([]);
  const [remoteGpu, setRemoteGpu] = useState<GpuSnapshot | null>(null);
  const [trainForm] = Form.useForm();
  const [normForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const initialTab = searchParams.get("tab") === "norm" ? "norm" : "train";
  const [tab, setTab] = useState(initialTab);

  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "norm" || t === "train") setTab(t);
  }, [searchParams]);

  useEffect(() => {
    api.getConfigs().then(setConfigs).catch((e) => message.error(`configs: ${e.message}`));
    api.getDatasets().then(setDatasets).catch((e) => message.error(`datasets: ${e.message}`));
    api.getRemotes().then(setRemotes).catch((e) => message.error(`remotes: ${e.message}`));
  }, []);

  useEffect(() => {
    const stateRepo = (location.state as { repoId?: string } | null)?.repoId;
    const repoId = stateRepo || pendingRepoId;
    if (repoId) {
      trainForm.setFieldValue("repoId", repoId);
      normForm.setFieldValue("repoId", repoId);
    }
    if (pendingRepoId) setPendingRepoId(null);
  }, [location.state, pendingRepoId, trainForm, normForm, setPendingRepoId]);

  useEffect(() => {
    trainForm.setFieldsValue({
      expName: `exp_${nowStamp()}`,
      numTrainSteps: 30000,
      seed: 42,
      batchSize: 32,
      logInterval: 100,
      saveInterval: 1000,
      keepPeriod: 5000,
      overwrite: true,
      resume: false,
      wandbEnabled: true,
      cudaVisibleDevices: ["0", "1"],
      xlaMemFraction: 0.9,
      targetHostId: "local",
      syncDataset: true,
    });
    normForm.setFieldsValue({});
  }, [trainForm, normForm]);

  useEffect(() => {
    if (configs.length === 0) return;
    const preferred = configs.find((c) => c.name === "pi0_rcvlab_low_mem_finetune");
    const defaultName = preferred?.name || configs[0].name;
    trainForm.setFieldValue("configName", trainForm.getFieldValue("configName") || defaultName);
    normForm.setFieldValue("configName", normForm.getFieldValue("configName") || defaultName);
  }, [configs, trainForm, normForm]);

  const datasetOptions = useMemo(
    () => datasets.map((d) => ({ value: d.repoId, label: d.repoId })),
    [datasets],
  );

  const handleConflict = (job: JobRecord) => {
    Modal.warning({
      title: "Another job is active",
      content: (
        <div>
          <p>{job.id}</p>
          <Button type="link" onClick={() => navigate(`/jobs/${job.id}`)}>
            Open active job
          </Button>
        </div>
      ),
    });
  };

  const wandbEnabled = Form.useWatch("wandbEnabled", trainForm);
  const overwrite = Form.useWatch("overwrite", trainForm);
  const resume = Form.useWatch("resume", trainForm);
  const targetHostId = Form.useWatch("targetHostId", trainForm);

  useEffect(() => {
    setRemoteGpu(null);
    if (!targetHostId || targetHostId === "local") return;
    api.getRemoteGpu(targetHostId).then(setRemoteGpu).catch((e) => message.error(`remote gpu: ${e.message}`));
  }, [targetHostId]);

  const submitTrain = async () => {
    const values = await trainForm.validateFields();
    const cuda = (values.cudaVisibleDevices as string[]).join(",");
    setSubmitting(true);
    try {
      const job = await api.launchTrain({
        configName: values.configName,
        expName: values.expName,
        repoId: values.repoId,
        numTrainSteps: values.numTrainSteps,
        seed: values.seed,
        batchSize: values.batchSize,
        logInterval: values.logInterval,
        saveInterval: values.saveInterval,
        keepPeriod: values.keepPeriod,
        targetHostId: values.targetHostId,
        syncDataset: values.syncDataset,
        overwrite: values.overwrite,
        resume: values.resume,
        wandbEnabled: values.wandbEnabled,
        cudaVisibleDevices: cuda,
        xlaMemFraction: values.xlaMemFraction,
      });
      navigate(`/jobs/${job.id}`);
    } catch (e: unknown) {
      const err = e as { message?: string; activeJob?: JobRecord };
      if (err.activeJob) handleConflict(err.activeJob);
      else message.error(err.message || "launch failed");
    } finally {
      setSubmitting(false);
    }
  };

  const submitNorm = async () => {
    const values = await normForm.validateFields();
    setSubmitting(true);
    try {
      const job = await api.launchNormStats({
        configName: values.configName,
        repoId: values.repoId,
        maxFrames: values.maxFrames,
      });
      navigate(`/jobs/${job.id}`);
    } catch (e: unknown) {
      const err = e as { message?: string; activeJob?: JobRecord };
      if (err.activeJob) handleConflict(err.activeJob);
      else message.error(err.message || "launch failed");
    } finally {
      setSubmitting(false);
    }
  };

  const configSelect = (
    <Select
      showSearch
      placeholder="Pick a TrainConfig"
      options={configs.map((c) => ({ value: c.name, label: c.name }))}
      filterOption={(input, opt) =>
        (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
      }
    />
  );

  return (
    <div style={{ maxWidth: 880 }}>
      <WandbSecretCard />
      <PreCommandCard />
      <Card>
        <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "norm",
            label: (
              <span>
                <ThunderboltOutlined /> 计算归一化（Norm Stats）
              </span>
            ),
            children: (
              <Form form={normForm} layout="vertical">
                <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
                  在训练前先跑一次。等价于：
                  <Typography.Text code>
                    uv run scripts/compute_norm_stats.py --config-name=&lt;cfg&gt; --repo-id=&lt;repo&gt;
                  </Typography.Text>
                </Typography.Paragraph>
                <Form.Item
                  name="configName"
                  label="Config"
                  rules={[{ required: true }]}
                >
                  {configSelect}
                </Form.Item>
                <Form.Item
                  name="repoId"
                  label="Repo ID override"
                  tooltip="huggingface 数据集仓库 ID（用户名/数据集），同时是训练时使用的数据"
                  rules={[{ required: true }, { pattern: /^[\w.\-]+\/[\w.\-]+$/, message: "format: user/dataset" }]}
                >
                  <AutoComplete options={datasetOptions} placeholder="luobai/pick_bag" />
                </Form.Item>
                <Form.Item name="maxFrames" label="Max frames (optional)">
                  <InputNumber min={1} style={{ width: 200 }} />
                </Form.Item>
                <Button
                  type="primary"
                  size="large"
                  icon={<ThunderboltOutlined />}
                  loading={submitting}
                  onClick={submitNorm}
                >
                  计算归一化统计
                </Button>
              </Form>
            ),
          },
          {
            key: "train",
            label: (
              <span>
                <RocketOutlined /> 开始训练
              </span>
            ),
            children: (
              <Form form={trainForm} layout="vertical">
                <Space size="large" wrap>
                  <Form.Item name="targetHostId" label="Training target" tooltip="Local 或远端 SSH 服务器">
                    <Select
                      options={remotes.map((h) => ({ value: h.id, label: h.label }))}
                      style={{ minWidth: 260 }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="syncDataset"
                    label="rsync dataset"
                    valuePropName="checked"
                    tooltip="远端训练前把当前 Repo ID 对应的数据集同步到远端 datasetRoot"
                  >
                    <Switch disabled={!targetHostId || targetHostId === "local"} />
                  </Form.Item>
                </Space>
                {targetHostId && targetHostId !== "local" && (
                  <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
                    Remote GPU: {remoteGpu?.available ? `${remoteGpu.gpus.length} GPUs · ${remoteGpu.gpus.map((g) => `GPU${g.index}:${g.memoryFreeMib}MiB free`).join(" · ")}` : remoteGpu?.error || "checking..."}
                  </Typography.Paragraph>
                )}
                <Form.Item name="configName" label="Config" rules={[{ required: true }]}> 
                  {configSelect}
                </Form.Item>
                <Form.Item name="expName" label="Experiment name" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item
                  name="repoId"
                  label="Repo ID"
                  tooltip="huggingface 数据集仓库 ID（用户名/数据集），同时是训练时使用的数据"
                  rules={[{ required: true }, { pattern: /^[\w.\-]+\/[\w.\-]+$/, message: "format: user/dataset" }]}
                >
                  <AutoComplete options={datasetOptions} placeholder="luobai/pick_bag" />
                </Form.Item>

                <Space size="large" wrap>
                  <Form.Item name="numTrainSteps" label="num_train_steps" tooltip="训练总步数">
                    <InputNumber min={1} step={1000} style={{ width: 160 }} />
                  </Form.Item>
                  <Form.Item name="seed" label="seed" tooltip="随机种子">
                    <InputNumber style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="batchSize" label="batch_size" tooltip="全局 batch size，必须能被 GPU 数整除">
                    <InputNumber min={1} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="logInterval" label="log_interval" tooltip="多少步输出一次日志">
                    <InputNumber min={1} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="saveInterval" label="save_interval" tooltip="多少步保存一次 checkpoint">
                    <InputNumber min={1} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="keepPeriod" label="keep_period" tooltip="保留 step % keepPeriod == 0 的 checkpoint">
                    <InputNumber min={1} style={{ width: 120 }} />
                  </Form.Item>
                </Space>

                <Space size="large" wrap>
                  <Form.Item
                    name="overwrite"
                    label="overwrite"
                    valuePropName="checked"
                    tooltip="是否覆盖之前的 checkpoints"
                  >
                    <Switch
                      onChange={(v) => {
                        if (v) trainForm.setFieldValue("resume", false);
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="resume"
                    label="resume"
                    valuePropName="checked"
                    tooltip="从已有 checkpoint 继续训练（与 overwrite 互斥）"
                  >
                    <Switch
                      onChange={(v) => {
                        if (v) trainForm.setFieldValue("overwrite", false);
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    name="wandbEnabled"
                    label="wandb"
                    valuePropName="checked"
                    tooltip="是否使用 wandb；不使用就关掉。key 在页面顶部统一配置一次，启动时后端自动注入"
                  >
                    <Switch />
                  </Form.Item>
                </Space>

                <Form.Item
                  name="cudaVisibleDevices"
                  label="CUDA_VISIBLE_DEVICES"
                  tooltip="可见的 GPU 编号"
                >
                  <Select
                    mode="multiple"
                    options={[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
                      value: String(i),
                      label: `GPU ${i}`,
                    }))}
                    style={{ minWidth: 240 }}
                  />
                </Form.Item>

                <Form.Item
                  name="xlaMemFraction"
                  label="XLA_PYTHON_CLIENT_MEM_FRACTION"
                  tooltip="XLA_PYTHON_CLIENT_MEM_FRACTION：占总显存比例"
                >
                  <Slider min={0.5} max={0.95} step={0.05} style={{ maxWidth: 400 }} />
                </Form.Item>

                <Button
                  type="primary"
                  size="large"
                  icon={<RocketOutlined />}
                  loading={submitting}
                  onClick={submitTrain}
                >
                  启动训练
                </Button>
                <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
                  overwrite={String(overwrite)} · resume={String(resume)} · wandb={String(wandbEnabled)}
                </Typography.Paragraph>
              </Form>
            ),
          },
        ]}
        />
      </Card>
    </div>
  );
}
