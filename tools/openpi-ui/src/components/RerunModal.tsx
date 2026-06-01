import { useEffect, useState } from "react";
import {
  AutoComplete,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Slider,
  Switch,
  message,
} from "antd";
import { api } from "../api/client";
import { DatasetInfo, JobRecord, NormStatsJobRequest, TrainJobRequest } from "../api/types";
import { WandbSecretCard } from "./WandbSecretCard";

interface Props {
  job: JobRecord | null;
  onClose: () => void;
  onLaunched: (job: JobRecord) => void;
}

function nowStamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function RerunModal({ job, onClose, onLaunched }: Props) {
  const [form] = Form.useForm();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const wandbEnabled = Form.useWatch("wandbEnabled", form);

  useEffect(() => {
    if (job) {
      api.getDatasets().then(setDatasets).catch(() => {});
    }
  }, [job]);

  useEffect(() => {
    if (!job) return;
    if (job.kind === "train") {
      const r = job.request as TrainJobRequest;
      form.setFieldsValue({
        ...r,
        wandbApiKey: undefined,
        cudaVisibleDevices:
          typeof r.cudaVisibleDevices === "string" && r.cudaVisibleDevices.length
            ? r.cudaVisibleDevices.split(",")
            : ["0"],
        expName: `exp_${nowStamp()}`,
      });
    } else {
      const r = job.request as NormStatsJobRequest;
      form.setFieldsValue({ ...r });
    }
  }, [job, form]);

  const isTrain = job?.kind === "train";

  const submit = async () => {
    if (!job) return;
    const v = await form.validateFields();
    setSubmitting(true);
    try {
      if (isTrain) {
        const cuda = (v.cudaVisibleDevices as string[] | undefined)?.join(",");
        const launched = await api.launchTrain({
          configName: v.configName,
          expName: v.expName,
          repoId: v.repoId,
          numTrainSteps: v.numTrainSteps,
          seed: v.seed,
          batchSize: v.batchSize,
          logInterval: v.logInterval,
          saveInterval: v.saveInterval,
          keepPeriod: v.keepPeriod,
          overwrite: v.overwrite,
          resume: v.resume,
          wandbEnabled: v.wandbEnabled,
          cudaVisibleDevices: cuda,
          xlaMemFraction: v.xlaMemFraction,
        });
        onLaunched(launched);
      } else {
        const launched = await api.launchNormStats({
          configName: v.configName,
          repoId: v.repoId,
          maxFrames: v.maxFrames,
        });
        onLaunched(launched);
      }
    } catch (e: unknown) {
      const err = e as { message?: string; activeJob?: JobRecord };
      message.error(err.message || "rerun failed");
      if (err.activeJob) {
        Modal.warning({
          title: "Another job is active",
          content: err.activeJob.id,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const datasetOptions = datasets.map((d) => ({ value: d.repoId, label: d.repoId }));

  return (
    <Modal
      open={!!job}
      title={job ? `Rerun ${job.kind} (from ${job.id})` : ""}
      onCancel={onClose}
      onOk={submit}
      okText="Launch"
      confirmLoading={submitting}
      width={620}
      destroyOnClose
    >
      {job && (
        <>
          {isTrain && (
            <div style={{ marginBottom: 12 }}>
              <WandbSecretCard compact />
            </div>
          )}
          <Form form={form} layout="vertical" size="small">
          <Form.Item name="configName" label="Config" rules={[{ required: true }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item
            name="repoId"
            label="Repo ID"
            rules={[{ pattern: /^[\w.\-]+\/[\w.\-]+$/, message: "format: user/dataset" }]}
          >
            <AutoComplete options={datasetOptions} allowClear />
          </Form.Item>

          {isTrain ? (
            <>
              <Form.Item name="expName" label="Experiment name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="numTrainSteps" label="num_train_steps">
                <InputNumber min={1} step={1000} style={{ width: 160 }} />
              </Form.Item>
              <Form.Item name="seed" label="seed">
                <InputNumber style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="batchSize" label="batch_size">
                <InputNumber min={1} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="logInterval" label="log_interval">
                <InputNumber min={1} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="saveInterval" label="save_interval">
                <InputNumber min={1} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="overwrite" label="overwrite" valuePropName="checked">
                <Switch
                  onChange={(v) => {
                    if (v) form.setFieldValue("resume", false);
                  }}
                />
              </Form.Item>
              <Form.Item name="resume" label="resume" valuePropName="checked">
                <Switch
                  onChange={(v) => {
                    if (v) form.setFieldValue("overwrite", false);
                  }}
                />
              </Form.Item>
              <Form.Item name="wandbEnabled" label="wandb" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="cudaVisibleDevices" label="CUDA_VISIBLE_DEVICES">
                <Select
                  mode="multiple"
                  options={[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
                    value: String(i),
                    label: `GPU ${i}`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="xlaMemFraction" label="XLA mem fraction">
                <Slider min={0.5} max={0.95} step={0.05} />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="maxFrames" label="Max frames (optional)">
              <InputNumber min={1} style={{ width: 200 }} />
            </Form.Item>
          )}
          </Form>
        </>
      )}
    </Modal>
  );
}
