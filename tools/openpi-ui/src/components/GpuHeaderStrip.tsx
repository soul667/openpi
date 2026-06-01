import { useEffect, useState } from "react";
import { Popover, Progress, Space, Table, Tag, Typography } from "antd";
import { api } from "../api/client";
import { GpuSnapshot } from "../api/types";

function fmtMib(mib: number) {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${mib} MiB`;
}

function pctColor(pct: number) {
  if (pct >= 85) return "#ff4d4f";
  if (pct >= 60) return "#faad14";
  if (pct >= 30) return "#1677ff";
  return "#52c41a";
}

export function GpuHeaderStrip() {
  const [snap, setSnap] = useState<GpuSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await api.getGpu();
      setSnap(s);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return <Tag color="error">GPU: {error}</Tag>;
  }
  if (!snap) {
    return <Tag>GPU…</Tag>;
  }
  if (!snap.available || snap.gpus.length === 0) {
    return <Tag>no GPU</Tag>;
  }

  const detail = (
    <div style={{ minWidth: 520, maxWidth: 720 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        GPUs
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        rowKey="index"
        dataSource={snap.gpus}
        columns={[
          { title: "#", dataIndex: "index", width: 40 },
          { title: "Name", dataIndex: "name", ellipsis: true },
          {
            title: "Memory",
            key: "mem",
            render: (_: unknown, g) => {
              const pct = (g.memoryUsedMib / g.memoryTotalMib) * 100;
              return (
                <Space direction="vertical" size={0} style={{ width: 180 }}>
                  <Progress
                    percent={pct}
                    showInfo={false}
                    strokeColor={pctColor(pct)}
                    size="small"
                  />
                  <span style={{ fontSize: 11, color: "#888" }}>
                    {fmtMib(g.memoryUsedMib)} / {fmtMib(g.memoryTotalMib)} ({Math.round(pct)}%)
                  </span>
                </Space>
              );
            },
          },
          { title: "Util", dataIndex: "utilizationPct", width: 60, render: (v: number) => `${v}%` },
          { title: "Temp", dataIndex: "temperatureC", width: 60, render: (v: number) => `${v}°C` },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 12 }}>
        Processes
      </Typography.Title>
      {snap.processes.length === 0 ? (
        <Typography.Text type="secondary">no compute processes</Typography.Text>
      ) : (
        <Table
          size="small"
          pagination={false}
          rowKey="pid"
          dataSource={snap.processes}
          columns={[
            { title: "GPU", dataIndex: "gpuIndex", width: 50 },
            { title: "PID", dataIndex: "pid", width: 80 },
            {
              title: "User",
              dataIndex: "user",
              width: 100,
              render: (v?: string) => v || <span style={{ color: "#bbb" }}>?</span>,
            },
            {
              title: "Memory",
              dataIndex: "memoryUsedMib",
              width: 100,
              render: (v: number) => fmtMib(v),
            },
            {
              title: "Command",
              dataIndex: "cmd",
              ellipsis: true,
              render: (v: string | undefined, row) => (
                <Typography.Text style={{ fontSize: 11 }} ellipsis={{ tooltip: v || row.processName }}>
                  {v || row.processName}
                </Typography.Text>
              ),
            },
          ]}
        />
      )}
    </div>
  );

  return (
    <Popover content={detail} placement="bottomRight" trigger="click">
      <Space size={4} style={{ cursor: "pointer" }}>
        {snap.gpus.map((g) => {
          const pct = (g.memoryUsedMib / g.memoryTotalMib) * 100;
          return (
            <div key={g.index} title={`GPU${g.index}: ${Math.round(pct)}%`} style={{ minWidth: 56 }}>
              <div style={{ fontSize: 10, color: "#888", textAlign: "center", lineHeight: 1 }}>
                #{g.index}
              </div>
              <Progress
                percent={pct}
                showInfo={false}
                strokeColor={pctColor(pct)}
                size="small"
                style={{ margin: 0 }}
              />
            </div>
          );
        })}
      </Space>
    </Popover>
  );
}
