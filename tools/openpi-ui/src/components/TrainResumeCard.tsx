import { useEffect, useMemo, useState } from "react";
import { Button, Card, Select, Space, Table, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { TrainExperimentInfo } from "../api/types";

export type ResumeSelection = {
  checkpointRunRelativePath: string;
  checkpointSource: "local" | "remote";
  checkpointHostId?: string;
  resumeStep?: number;
  expName: string;
  usePytorch?: boolean;
};

type Props = {
  configName?: string;
  onChange: (v: ResumeSelection | null) => void;
};

function fmtTime(ms: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

export function TrainResumeCard({ configName, onChange }: Props) {
  const [rows, setRows] = useState<TrainExperimentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [step, setStep] = useState<number | undefined>();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getTrainCheckpoints(configName);
      setRows(res.experiments);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [configName]);

  const selectedRow = useMemo(
    () => rows.find((r) => `${r.source}:${r.hostId || "local"}:${r.runRelativePath}` === selectedKey),
    [rows, selectedKey],
  );

  const emit = (row: TrainExperimentInfo | undefined, resumeStep?: number) => {
    if (!row) {
      onChange(null);
      return;
    }
    const s = resumeStep ?? row.steps[0];
    onChange({
      checkpointRunRelativePath: row.runRelativePath,
      checkpointSource: row.source,
      checkpointHostId: row.hostId,
      resumeStep: s,
      expName: row.expName,
      usePytorch: row.backendHint === "torch" ? true : row.backendHint === "jax" ? false : undefined,
    });
  };

  const columns = [
    {
      title: "来源",
      key: "src",
      width: 120,
      render: (_: unknown, r: TrainExperimentInfo) => (
        <Typography.Text style={{ fontSize: 11 }}>{r.hostLabel || "Local"}</Typography.Text>
      ),
    },
    {
      title: "实验",
      dataIndex: "runRelativePath",
      key: "path",
      render: (v: string) => (
        <Typography.Text code style={{ fontSize: 11 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: "步数",
      key: "steps",
      width: 100,
      render: (_: unknown, r: TrainExperimentInfo) => r.steps.length,
    },
    {
      title: "后端",
      dataIndex: "backendHint",
      width: 64,
      render: (v: string) => v || "-",
    },
    {
      title: "更新",
      dataIndex: "mtimeMs",
      width: 150,
      render: (ms: number) => fmtTime(ms),
    },
  ];

  return (
    <Card
      size="small"
      title="从 Checkpoint 继续训练"
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
          刷新
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        列出本机与各远程机上的训练 run（含数字 step 目录）。选中后自动设置 exp_name、resume，远程会先 rsync 到本机再同步到训练目标机。
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey={(r) => `${r.source}:${r.hostId || "local"}:${r.runRelativePath}`}
        dataSource={rows.slice(0, 40)}
        columns={columns}
        loading={loading}
        pagination={false}
        rowSelection={{
          type: "radio",
          selectedRowKeys: selectedKey ? [selectedKey] : [],
          onChange: (keys) => {
            const k = (keys[0] as string) || null;
            setSelectedKey(k);
            const row = rows.find((r) => `${r.source}:${r.hostId || "local"}:${r.runRelativePath}` === k);
            const s = row?.steps[0];
            setStep(s);
            emit(row, s);
          },
        }}
      />
      {selectedRow && (
        <Space style={{ marginTop: 12 }} wrap>
          <Typography.Text>恢复步数</Typography.Text>
          <Select
            style={{ minWidth: 140 }}
            value={step ?? selectedRow.steps[0]}
            onChange={(s) => {
              setStep(s);
              if (selectedRow) emit(selectedRow, s);
            }}
            options={selectedRow.steps.map((s) => ({ value: s, label: String(s) }))}
          />
          <Typography.Text type="secondary">未选步数时默认最新 step</Typography.Text>
        </Space>
      )}
    </Card>
  );
}