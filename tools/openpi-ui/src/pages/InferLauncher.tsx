import { useEffect, useMemo, useState } from "react";
import {
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { ConfigInfo, InferJobRequest, JobRecord, LocalCheckpointInfo } from "../api/types";
import { InferEnvCard } from "../components/InferEnvCard";
import { useJobsStore } from "../store/jobs";

function fmtTime(ms: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

export function InferLauncher() {
  const navigate = useNavigate();
  const jobs = useJobsStore((s) => s.jobs);
  const fetchJobs = useJobsStore((s) => s.fetchJobs);
  const [configs, setConfigs] = useState<ConfigInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<LocalCheckpointInfo[]>([]);
  const [loadingCkpt, setLoadingCkpt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<InferJobRequest>();

  const watchedConfig = Form.useWatch("configName", form);

  const inferJobs = useMemo(
    () => jobs.filter((j) => j.kind === "infer").slice(0, 8),
    [jobs],
  );

  const runningInferCount = useMemo(
    () => inferJobs.filter((j) => j.status === "queued" || j.status === "running").length,
    [inferJobs],
  );

  const loadCheckpoints = async () => {
    setLoadingCkpt(true);
    try {
      const res = await api.getLocalCheckpoints();
      setCheckpoints(res.checkpoints);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoadingCkpt(false);
    }
  };

  useEffect(() => {
    api.getConfigs().then(setConfigs).catch((e) => message.error(`configs: ${e.message}`));
    loadCheckpoints();
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    if (!watchedConfig) return;
    const cfg = configs.find((c) => c.name === watchedConfig);
    if (cfg?.defaultRepoId && !form.getFieldValue("repoId")) {
      form.setFieldValue("repoId", cfg.defaultRepoId);
    }
    const match = checkpoints.filter((c) => c.configName === watchedConfig);
    if (match.length && !form.getFieldValue("checkpointDir")) {
      form.setFieldValue("checkpointDir", match[0].absolutePath);
    }
  }, [watchedConfig, configs, checkpoints, form]);

  const checkpointOptions = useMemo(() => {
    const filtered = watchedConfig
      ? checkpoints.filter((c) => c.configName === watchedConfig)
      : checkpoints;
    return filtered.map((c) => ({
      value: c.absolutePath,
      label: `${c.relativePath} (${c.backendHint || "?"})`,
    }));
  }, [checkpoints, watchedConfig]);

  const onFinish = async (values: InferJobRequest) => {
    setSubmitting(true);
    try {
      const job = await api.launchInfer(values);
      message.success(`已启动推理服务 ${job.id}`);
      fetchJobs();
      navigate(`/jobs/${job.id}`);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const ckptColumns = [
    {
      title: "路径",
      dataIndex: "relativePath",
      key: "path",
      render: (v: string, row: LocalCheckpointInfo) => (
        <Typography.Text code style={{ fontSize: 11 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: "后端",
      dataIndex: "backendHint",
      width: 70,
      render: (v: string) => v || "-",
    },
    {
      title: "修改时间",
      dataIndex: "mtimeMs",
      width: 160,
      render: (ms: number) => fmtTime(ms),
    },
    {
      title: "",
      key: "use",
      width: 80,
      render: (_: unknown, row: LocalCheckpointInfo) => (
        <Button
          size="small"
          type="link"
          onClick={() => {
            form.setFieldsValue({
              configName: row.configName,
              checkpointDir: row.absolutePath,
            });
          }}
        >
          选用
        </Button>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1100 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        推理服务（ZMQ / pi0.5）
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        在宿主机 conda 环境中启动 <Typography.Text code>tools/zbl_dm/run_pi05_server.sh</Typography.Text>
        ，自动加载 OpenPI 配置与 checkpoint。
      </Typography.Paragraph>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12, alignItems: "start" }}>
        <Card size="small" title="启动参数">
          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            initialValues={{
              bind: "tcp://0.0.0.0:5555",
              backend: "jax",
              chunkSize: 1,
              maxJointStepDeg: 2,
              missingImage: "error",
              cudaVisibleDevices: "0",
              prompt: "move to the target",
            }}
          >
            <Form.Item name="configName" label="OpenPI config" rules={[{ required: true }]}>
              <Select
                showSearch
                options={configs.map((c) => ({ value: c.name, label: c.name }))}
                placeholder="pi05_mtbot"
              />
            </Form.Item>
            <Form.Item name="checkpointDir" label="Checkpoint 目录" rules={[{ required: true }]}>
              <AutoComplete options={checkpointOptions} placeholder="/data2/axgu/code/openpi/checkpoints/..." />
            </Form.Item>
            <Form.Item name="prompt" label="默认 prompt" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Space wrap size="large">
              <Form.Item name="bind" label="ZMQ bind">
                <Input style={{ width: 220 }} />
              </Form.Item>
              <Form.Item name="backend" label="Backend">
                <Select
                  style={{ width: 120 }}
                  options={[
                    { value: "jax", label: "JAX" },
                    { value: "torch", label: "PyTorch" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="cudaVisibleDevices" label="CUDA_VISIBLE_DEVICES">
                <Input style={{ width: 100 }} />
              </Form.Item>
              <Form.Item name="chunkSize" label="chunk-size">
                <InputNumber min={1} max={10} />
              </Form.Item>
              <Form.Item name="maxJointStepDeg" label="max-joint-step-deg">
                <InputNumber min={0.1} step={0.5} />
              </Form.Item>
              <Form.Item name="missingImage" label="missing-image">
                <Select
                  style={{ width: 120 }}
                  options={[
                    { value: "error", label: "error" },
                    { value: "zeros", label: "zeros" },
                  ]}
                />
              </Form.Item>
            </Space>
            <Form.Item name="repoId" label="repo-id（可选，覆盖 config）">
              <Input placeholder="user/dataset" />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={submitting}>
              启动推理服务
            </Button>
            {runningInferCount > 0 && (
              <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                当前 {runningInferCount} 个推理在运行（GPU/端口不可与已有实例冲突）
              </Typography.Text>
            )}
          </Form>
        </Card>
        <InferEnvCard />
      </div>

      <Card
        size="small"
        title="本地 Checkpoints"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={loadingCkpt} onClick={loadCheckpoints}>
            刷新
          </Button>
        }
      >
        <Table
          size="small"
          rowKey="relativePath"
          dataSource={checkpoints.slice(0, 30)}
          columns={ckptColumns}
          pagination={false}
          loading={loadingCkpt}
        />
      </Card>

      {inferJobs.length > 0 && (
        <Card size="small" title="最近推理任务">
          <Space direction="vertical" style={{ width: "100%" }}>
            {inferJobs.map((j: JobRecord) => (
              <Button key={j.id} type="link" style={{ padding: 0 }} onClick={() => navigate(`/jobs/${j.id}`)}>
                {j.id} — {j.status} — {j.configName}
              </Button>
            ))}
          </Space>
        </Card>
      )}
    </div>
  );
}