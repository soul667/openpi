import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Modal,
  Radio,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from "antd";
import { api } from "../api/client";
import { DatasetInfo, GripperMode, GripperStats } from "../api/types";

interface Props {
  dataset: DatasetInfo | null;
  onClose: () => void;
  onApplied: () => void;
}

export function GripperNormalizeModal({ dataset, onClose, onApplied }: Props) {
  const [stats, setStats] = useState<GripperStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [mode, setMode] = useState<GripperMode>("threshold-binary");
  const [threshold, setThreshold] = useState<number>(0);
  const [minVal, setMinVal] = useState<number>(0);
  const [maxVal, setMaxVal] = useState<number>(1);
  const [divisor, setDivisor] = useState<number>(98);

  const refresh = async () => {
    if (!dataset) return;
    setLoading(true);
    try {
      const s = await api.getGripperStats(dataset.user, dataset.dataset);
      setStats(s);
      const a = s.stats.action || s.stats["observation.state"];
      if (a) {
        setMinVal(a.min);
        setMaxVal(a.max);
        setThreshold(Number(((a.min + a.max) / 2).toFixed(3)));
        if (a.max > 50) setDivisor(98);
        else if (a.max > 5) setDivisor(10);
        else setDivisor(1);
      }
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (dataset) refresh();
    else setStats(null);
  }, [dataset]);

  const apply = async () => {
    if (!dataset) return;
    let params: Record<string, number>;
    if (mode === "threshold-binary") params = { threshold };
    else if (mode === "minmax-01") params = { min: minVal, max: maxVal };
    else params = { divisor };
    Modal.confirm({
      title: "确认归一化？",
      content: (
        <div>
          <p>
            将就地修改 <code>{dataset.repoId}</code> 的所有 parquet 数据；先自动备份整个数据集到 .bak.&lt;timestamp&gt;
          </p>
          <p>
            模式：<Tag color="blue">{mode}</Tag> 参数：{JSON.stringify(params)}
          </p>
          <p style={{ color: "#cf1322" }}>
            提示：归一化后必须重新跑 Compute Norm Stats，否则训练读到的统计仍是旧值。
          </p>
        </div>
      ),
      okText: "确认执行",
      okType: "primary",
      onOk: async () => {
        setApplying(true);
        try {
          const r = await api.normalizeGripper(dataset.user, dataset.dataset, {
            mode,
            params,
            backup: true,
          });
          message.success(
            `已归一化 ${r.filesChanged}/${r.filesProcessed} 个文件，备份到 ${r.backupPath || "(none)"}`,
            6,
          );
          onApplied();
          onClose();
        } catch (e: unknown) {
          message.error((e as Error).message);
        } finally {
          setApplying(false);
        }
      },
    });
  };

  if (!dataset) return null;
  const action = stats?.stats.action;
  const obs = stats?.stats["observation.state"];
  const isAlreadyNormalized = action && action.min >= -1 && action.max <= 1;

  return (
    <Modal
      open={!!dataset}
      title={`Normalize gripper — ${dataset.repoId}`}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="refresh" onClick={refresh} loading={loading}>
          刷新统计
        </Button>,
        <Button key="apply" type="primary" danger onClick={apply} loading={applying} disabled={!stats}>
          执行归一化
        </Button>,
      ]}
      width={720}
    >
      {loading && !stats && <div>读取数据中…</div>}
      {stats && (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="文件数">{stats.fileCount}</Descriptions.Item>
            <Descriptions.Item label="action 维度">{stats.dims.action ?? "?"}</Descriptions.Item>
            <Descriptions.Item label="state 维度">{stats.dims["observation.state"] ?? "?"}</Descriptions.Item>
            <Descriptions.Item label="夹爪所在列" span={3}>
              <Tag color="blue">index {stats.gripperIdx}</Tag> （取最后一维）
            </Descriptions.Item>
          </Descriptions>

          {action && (
            <div>
              <Typography.Text strong>action[{stats.gripperIdx}] 当前分布</Typography.Text>
              <Space size="large" wrap style={{ marginTop: 8 }}>
                <Statistic title="min" value={action.min.toFixed(3)} />
                <Statistic title="max" value={action.max.toFixed(3)} />
                <Statistic title="mean" value={action.mean.toFixed(3)} />
                <Statistic title="std" value={action.std.toFixed(3)} />
                <Statistic title="unique" value={action.unique_count} />
              </Space>
              <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                unique values preview: [{action.unique_preview.map((v) => v.toFixed(2)).join(", ")}]
              </div>
            </div>
          )}

          {obs && (
            <div>
              <Typography.Text strong>observation.state[{stats.gripperIdx}] 当前分布</Typography.Text>
              <Space size="large" wrap style={{ marginTop: 8 }}>
                <Statistic title="min" value={obs.min.toFixed(3)} />
                <Statistic title="max" value={obs.max.toFixed(3)} />
                <Statistic title="mean" value={obs.mean.toFixed(3)} />
                <Statistic title="std" value={obs.std.toFixed(3)} />
                <Statistic title="unique" value={obs.unique_count} />
              </Space>
            </div>
          )}

          {isAlreadyNormalized && (
            <Alert
              type="success"
              showIcon
              message="夹爪通道看起来已经在 [-1, 1] 区间，可能不需要再归一化。"
            />
          )}

          <div>
            <Typography.Text strong>归一化模式</Typography.Text>
            <Radio.Group
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              style={{ display: "block", marginTop: 8 }}
            >
              <Space direction="vertical">
                <Radio value="threshold-binary">
                  阈值二值化 → 0/1（推荐：你的夹爪本来就只有两个值）
                  {mode === "threshold-binary" && (
                    <span style={{ marginLeft: 12 }}>
                      阈值：
                      <InputNumber
                        size="small"
                        value={threshold}
                        step={0.1}
                        onChange={(v) => setThreshold(Number(v) || 0)}
                      />
                      <span style={{ marginLeft: 8, color: "#888", fontSize: 12 }}>
                        ≥ 阈值 → 1，否则 0
                      </span>
                    </span>
                  )}
                </Radio>
                <Radio value="minmax-01">
                  Min-Max → [0, 1]
                  {mode === "minmax-01" && (
                    <span style={{ marginLeft: 12 }}>
                      min:
                      <InputNumber
                        size="small"
                        value={minVal}
                        step={0.1}
                        onChange={(v) => setMinVal(Number(v) || 0)}
                      />{" "}
                      max:
                      <InputNumber
                        size="small"
                        value={maxVal}
                        step={0.1}
                        onChange={(v) => setMaxVal(Number(v) || 1)}
                      />
                    </span>
                  )}
                </Radio>
                <Radio value="divide">
                  除以固定常数
                  {mode === "divide" && (
                    <span style={{ marginLeft: 12 }}>
                      divisor:
                      <InputNumber
                        size="small"
                        value={divisor}
                        step={1}
                        onChange={(v) => setDivisor(Number(v) || 1)}
                      />
                    </span>
                  )}
                </Radio>
              </Space>
            </Radio.Group>
          </div>

          <Alert
            type="warning"
            showIcon
            message="操作不可逆但有备份"
            description={
              <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
                <li>会就地改写 data/**/*.parquet</li>
                <li>整个数据集目录会先备份到 &lt;dataset&gt;.bak.&lt;timestamp&gt;</li>
                <li>归一化完成后请重新跑 Compute Norm Stats</li>
              </ul>
            }
          />
        </Space>
      )}
    </Modal>
  );
}
