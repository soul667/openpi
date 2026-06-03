import { useEffect, useState } from "react";
import { Button, Card, Modal, Select, Space, Table, Typography, message } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { RemoteCheckpointInfo, RemoteHost } from "../api/types";

function fmtTime(ms: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function localCheckpointPath(relativePath: string) {
  return `/data2/axgu/code/openpi/checkpoints/${relativePath}`;
}

export function Checkpoints() {
  const [remotes, setRemotes] = useState<RemoteHost[]>([]);
  const [hostId, setHostId] = useState<string>();
  const [rows, setRows] = useState<RemoteCheckpointInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);

  useEffect(() => {
    api.getRemotes().then((hosts) => {
      const remoteOnly = hosts.filter((h) => h.id !== "local");
      setRemotes(remoteOnly);
      setHostId((cur) => cur || remoteOnly[0]?.id);
    }).catch((e) => message.error(e.message));
  }, []);

  const load = async () => {
    if (!hostId) return;
    setLoading(true);
    try {
      const res = await api.getRemoteCheckpoints(hostId);
      setRows(res.checkpoints);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [hostId]);

  const doPull = async (row: RemoteCheckpointInfo) => {
    setPulling(row.relativePath);
    try {
      const res = await api.pullRemoteCheckpoint(row.hostId, row.relativePath);
      message.success(`Pulled to ${res.localPath}`);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setPulling(null);
    }
  };

  const pull = (row: RemoteCheckpointInfo) => {
    Modal.confirm({
      title: "Pull checkpoint back to this host?",
      content: (
        <div>
          <div>Remote: <Typography.Text code>{row.remotePath}</Typography.Text></div>
          <div>Local: <Typography.Text code>{localCheckpointPath(row.relativePath)}</Typography.Text></div>
        </div>
      ),
      onOk: () => doPull(row),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card size="small" title="Remote checkpoints">
        <Space wrap>
          <Select
            value={hostId}
            options={remotes.map((h) => ({ value: h.id, label: h.label }))}
            onChange={setHostId}
            style={{ minWidth: 280 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            Refresh
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          Select a remote checkpoint directory and pull it back to this host under <Typography.Text code>/data2/axgu/code/openpi/checkpoints</Typography.Text>.
        </Typography.Paragraph>
      </Card>
      <Table
        rowKey={(r) => `${r.hostId}:${r.relativePath}`}
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: "Checkpoint",
            dataIndex: "relativePath",
            key: "relativePath",
            render: (p: string) => <Typography.Text code>{p}</Typography.Text>,
          },
          { title: "Remote path", dataIndex: "remotePath", key: "remotePath", render: (p: string) => <Typography.Text copyable style={{ fontSize: 12 }}>{p}</Typography.Text> },
          { title: "Local destination", key: "localPath", render: (_: unknown, r: RemoteCheckpointInfo) => <Typography.Text copyable style={{ fontSize: 12 }}>{localCheckpointPath(r.relativePath)}</Typography.Text> },
          { title: "Modified", key: "mtime", width: 190, render: (_: unknown, r: RemoteCheckpointInfo) => fmtTime(r.mtimeMs) },
          {
            title: "Action",
            key: "action",
            width: 150,
            render: (_: unknown, r: RemoteCheckpointInfo) => (
              <Button
                size="small"
                icon={<DownloadOutlined />}
                loading={pulling === r.relativePath}
                onClick={() => pull(r)}
              >
                Pull back
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
