import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import {
  DatasetInfo,
  NormStatsDetail,
  NormStatsDimDiag,
  NormStatsField,
  NormStatsFile,
  NormStatsOverrides,
} from "../api/types";

interface Props {
  dataset: DatasetInfo | null;
  onClose: () => void;
}

type EditTable = Record<string, Record<NormStatsField, Record<number, number>>>;

const FIELDS: NormStatsField[] = ["mean", "std", "q01", "q99"];
const FIELD_LABEL: Record<NormStatsField, string> = {
  mean: "mean",
  std: "std",
  q01: "q01",
  q99: "q99",
};

function fmt(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1000 || (Math.abs(n) > 0 && Math.abs(n) < 0.001)) return n.toExponential(3);
  return n.toFixed(4);
}

function quantileNormPreview(x: number, q01: number, q99: number): number {
  return ((x - q01) / (q99 - q01 + 1e-6)) * 2 - 1;
}

export function NormStatsModal({ dataset, onClose }: Props) {
  const [files, setFiles] = useState<NormStatsFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<NormStatsDetail | null>(null);
  const [activeKey, setActiveKey] = useState<string>("state");
  const [edits, setEdits] = useState<EditTable>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setFiles([]);
    setSelectedPath(null);
    setDetail(null);
    setEdits({});
  };

  const loadList = async () => {
    if (!dataset) return;
    setLoading(true);
    try {
      const r = await api.listNormStats(dataset.user, dataset.dataset);
      setFiles(r.files);
      if (r.files.length > 0) {
        setSelectedPath(r.files[0].path);
      } else {
        setDetail(null);
      }
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (path: string) => {
    setLoading(true);
    try {
      const r = await api.getNormStats(path);
      setDetail(r);
      const keys = Object.keys(r.stats);
      if (keys.length > 0 && !keys.includes(activeKey)) {
        setActiveKey(keys[0]);
      }
      setEdits({});
    } catch (e: unknown) {
      message.error((e as Error).message);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (dataset) loadList();
    else reset();
  }, [dataset]);

  useEffect(() => {
    if (selectedPath) loadDetail(selectedPath);
  }, [selectedPath]);

  const entry = detail?.stats[activeKey];
  const diagnostics: NormStatsDimDiag[] = detail?.diagnostics[activeKey] || [];

  const dimRows = useMemo(() => {
    if (!entry) return [];
    const n =
      Math.max(
        entry.mean?.length || 0,
        entry.std?.length || 0,
        entry.q01?.length || 0,
        entry.q99?.length || 0,
      ) || 0;
    return Array.from({ length: n }, (_, i) => {
      const diag = diagnostics.find((d) => d.dim === i);
      const editsForKey = edits[activeKey] || ({} as Record<NormStatsField, Record<number, number>>);
      return {
        dim: i,
        mean: entry.mean?.[i],
        std: entry.std?.[i],
        q01: entry.q01?.[i],
        q99: entry.q99?.[i],
        diag,
        edits: {
          mean: editsForKey.mean?.[i],
          std: editsForKey.std?.[i],
          q01: editsForKey.q01?.[i],
          q99: editsForKey.q99?.[i],
        },
      };
    });
  }, [entry, diagnostics, edits, activeKey]);

  const setEdit = (key: string, field: NormStatsField, dim: number, val: number | null) => {
    setEdits((prev) => {
      const next: EditTable = { ...prev };
      const keyEdits = { ...(next[key] || ({} as Record<NormStatsField, Record<number, number>>)) };
      const fieldEdits = { ...(keyEdits[field] || {}) };
      if (val === null || val === undefined || Number.isNaN(val)) {
        delete fieldEdits[dim];
      } else {
        fieldEdits[dim] = val;
      }
      keyEdits[field] = fieldEdits;
      next[key] = keyEdits;
      return next;
    });
  };

  const editCount = useMemo(() => {
    let n = 0;
    for (const k of Object.keys(edits)) {
      for (const f of FIELDS) {
        n += Object.keys(edits[k]?.[f] || {}).length;
      }
    }
    return n;
  }, [edits]);

  const buildOverrides = (): NormStatsOverrides => {
    const out: NormStatsOverrides = {};
    for (const k of Object.keys(edits)) {
      const fieldMap: NormStatsOverrides[string] = {};
      for (const f of FIELDS) {
        const dimMap = edits[k]?.[f];
        if (dimMap && Object.keys(dimMap).length > 0) {
          const stringKeyed: Record<string, number> = {};
          for (const d of Object.keys(dimMap)) {
            stringKeyed[d] = dimMap[Number(d)];
          }
          fieldMap[f] = { dims: stringKeyed };
        }
      }
      if (Object.keys(fieldMap).length > 0) out[k] = fieldMap;
    }
    return out;
  };

  const apply = async () => {
    if (!detail || editCount === 0) return;
    Modal.confirm({
      title: "确认保存修改？",
      content: (
        <div>
          <p>
            将就地修改 <code>{detail.path}</code>，自动备份到 <code>norm_stats.json.bak.&lt;timestamp&gt;</code>
          </p>
          <p>
            修改条目：<Tag color="blue">{editCount}</Tag>
          </p>
          <Alert
            type="info"
            showIcon
            message="保存后无需重新计算 norm stats，直接训练即可读到新值"
          />
        </div>
      ),
      okText: "确认保存",
      okType: "primary",
      onOk: async () => {
        if (!detail) return;
        setSaving(true);
        try {
          const r = await api.patchNormStats({
            path: detail.path,
            overrides: buildOverrides(),
            backup: true,
          });
          message.success(`保存成功，修改 ${r.changedDims.length} 项`);
          await loadDetail(detail.path);
        } catch (e: unknown) {
          message.error((e as Error).message);
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const autoFixDim = (dim: number) => {
    if (!entry) return;
    const q01 = entry.q01?.[dim];
    const q99 = entry.q99?.[dim];
    const std = entry.std?.[dim];
    const mean = entry.mean?.[dim];
    if (q01 === undefined || q99 === undefined) return;
    const center = (q01 + q99) / 2;
    const halfSpan = Math.max(0.05, (std !== undefined ? std * 5 : 0), (q99 - q01) * 10);
    const newQ01 = center - halfSpan;
    const newQ99 = center + halfSpan;
    setEdit(activeKey, "q01", dim, Number(newQ01.toFixed(6)));
    setEdit(activeKey, "q99", dim, Number(newQ99.toFixed(6)));
    if (mean !== undefined && std !== undefined && std < 1e-3) {
      setEdit(activeKey, "std", dim, Number((halfSpan / 3).toFixed(6)));
    }
  };

  const columns = [
    {
      title: "dim",
      dataIndex: "dim",
      width: 50,
      render: (i: number, row: (typeof dimRows)[number]) => {
        const flagged = row.diag?.spanNearZero || row.diag?.stdNearZero;
        return (
          <Space size={4}>
            <Typography.Text strong>{i}</Typography.Text>
            {flagged ? <Tag color="red">⚠</Tag> : null}
          </Space>
        );
      },
    },
    ...FIELDS.map((field) => ({
      title: FIELD_LABEL[field],
      dataIndex: field,
      width: 150,
      render: (val: number | undefined, row: (typeof dimRows)[number]) => {
        const edited = row.edits[field];
        const display = edited !== undefined ? edited : val;
        const changed = edited !== undefined && edited !== val;
        return (
          <InputNumber<number>
            size="small"
            value={display}
            onChange={(v) => setEdit(activeKey, field, row.dim, v as number | null)}
            step={0.01}
            style={{
              width: "100%",
              backgroundColor: changed ? "#fff7e6" : undefined,
              borderColor: changed ? "#fa8c16" : undefined,
            }}
            controls={false}
          />
        );
      },
    })),
    {
      title: "span (q99-q01)",
      key: "span",
      width: 130,
      render: (_: unknown, row: (typeof dimRows)[number]) => {
        const span = row.diag?.span;
        if (span === undefined) return "-";
        const flagged = row.diag?.spanNearZero;
        return <Tag color={flagged ? "red" : span < 0.1 ? "orange" : "default"}>{fmt(span)}</Tag>;
      },
    },
    {
      title: "诊断",
      key: "diag",
      width: 200,
      render: (_: unknown, row: (typeof dimRows)[number]) => {
        const tags: JSX.Element[] = [];
        if (row.diag?.spanNearZero)
          tags.push(
            <Tag key="span" color="red">
              q01≈q99
            </Tag>,
          );
        if (row.diag?.stdNearZero)
          tags.push(
            <Tag key="std" color="red">
              std≈0
            </Tag>,
          );
        if (tags.length === 0) tags.push(<Tag key="ok" color="green">OK</Tag>);
        return <Space size={4}>{tags}</Space>;
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render: (_: unknown, row: (typeof dimRows)[number]) => {
        const flagged = row.diag?.spanNearZero || row.diag?.stdNearZero;
        return (
          <Button size="small" disabled={!flagged} onClick={() => autoFixDim(row.dim)}>
            自动修复
          </Button>
        );
      },
    },
  ];

  const flaggedCount = diagnostics.filter((d) => d.spanNearZero || d.stdNearZero).length;

  const previewProblemDim = useMemo(() => {
    const flagged = diagnostics.find((d) => d.spanNearZero);
    if (!flagged || !entry) return null;
    const q01 = entry.q01?.[flagged.dim];
    const q99 = entry.q99?.[flagged.dim];
    if (q01 === undefined || q99 === undefined) return null;
    const probe = q01 - (q99 - q01) * 50;
    const normed = quantileNormPreview(probe, q01, q99);
    return {
      dim: flagged.dim,
      q01,
      q99,
      span: q99 - q01,
      normed,
    };
  }, [diagnostics, entry]);

  return (
    <Modal
      open={!!dataset}
      onCancel={onClose}
      footer={null}
      width={1100}
      title={
        <Space>
          <span>预览/修复 Norm Stats</span>
          {dataset ? <Tag color="blue">{dataset.repoId}</Tag> : null}
        </Space>
      }
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Space wrap>
          <Typography.Text>config:</Typography.Text>
          <Select
            value={selectedPath || undefined}
            style={{ minWidth: 360 }}
            options={files.map((f) => ({
              value: f.path,
              label: `${f.configName}  (${new Date(f.mtimeMs).toLocaleString()})`,
            }))}
            onChange={(v) => setSelectedPath(v)}
            placeholder="选择 norm_stats.json"
          />
          <Button icon={<ReloadOutlined />} onClick={loadList} loading={loading}>
            刷新
          </Button>
          {detail ? (
            <Radio.Group
              value={activeKey}
              onChange={(e) => setActiveKey(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              {Object.keys(detail.stats).map((k) => (
                <Radio.Button key={k} value={k}>
                  {k}
                </Radio.Button>
              ))}
            </Radio.Group>
          ) : null}
        </Space>

        {files.length === 0 && !loading ? (
          <Alert
            type="warning"
            showIcon
            message="未找到 norm_stats.json"
            description={
              <span>
                这个数据集还没有任何 config 计算过 norm stats。请先在数据列表上点 <b>计算归一化</b>。
              </span>
            }
          />
        ) : null}

        {flaggedCount > 0 ? (
          <Alert
            type="error"
            showIcon
            message={`检测到 ${flaggedCount} 个问题维度`}
            description={
              <div>
                <div>
                  pi05 用 quantile 归一化（公式 <code>(x - q01) / (q99 - q01 + 1e-6) * 2 - 1</code>）。
                  当某维度 <code>q99 ≈ q01</code> 时，分母趋零，离群样本归一化后会被放大几十倍，bf16 链路下立即 NaN。
                </div>
                {previewProblemDim ? (
                  <div style={{ marginTop: 6 }}>
                    示例 dim {previewProblemDim.dim}：q01=
                    <code>{fmt(previewProblemDim.q01)}</code>, q99=
                    <code>{fmt(previewProblemDim.q99)}</code>, span=
                    <code>{fmt(previewProblemDim.span)}</code> → 一个稍微偏离的样本归一化后可达
                    <Tag color="red" style={{ marginLeft: 6 }}>
                      {fmt(previewProblemDim.normed)}
                    </Tag>
                  </div>
                ) : null}
                <div style={{ marginTop: 6, color: "#666" }}>
                  推荐做法：把红色维度 q01/q99 的范围扩大到能覆盖真实数据 ± 一点 margin。点"自动修复"会把范围扩到约 std×5。
                </div>
              </div>
            }
          />
        ) : null}

        <Table
          columns={columns}
          dataSource={dimRows}
          rowKey="dim"
          size="small"
          pagination={false}
          loading={loading}
          rowClassName={(row) =>
            row.diag?.spanNearZero || row.diag?.stdNearZero ? "row-flagged" : ""
          }
        />

        <Space>
          <Button
            type="primary"
            disabled={editCount === 0}
            loading={saving}
            onClick={apply}
          >
            保存修改 {editCount > 0 ? `(${editCount})` : ""}
          </Button>
          <Button disabled={editCount === 0} onClick={() => setEdits({})}>
            清空修改
          </Button>
          {detail ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              文件: <code>{detail.path}</code>
            </Typography.Text>
          ) : null}
        </Space>
      </Space>
    </Modal>
  );
}
