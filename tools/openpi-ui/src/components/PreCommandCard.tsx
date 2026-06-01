import { useEffect, useState } from "react";
import { Button, Card, Input, Modal, Space, Tag, Typography, message } from "antd";
import { CodeOutlined } from "@ant-design/icons";
import { api } from "../api/client";

export function PreCommandCard({ compact = false }: { compact?: boolean }) {
  const [preCommand, setPreCommand] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      const r = await api.getPreCommand();
      setPreCommand(r.preCommand);
    } catch (e: unknown) {
      message.error((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const startEdit = () => {
    setDraft(preCommand);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.savePreCommand(draft);
      setPreCommand(r.preCommand);
      setEditing(false);
      message.success("已保存");
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    Modal.confirm({
      title: "恢复默认前置命令？",
      content: "默认值是 export http_proxy=http://127.0.0.1:1081 https_proxy=http://127.0.0.1:1081",
      onOk: async () => {
        try {
          const r = await api.resetPreCommand();
          setPreCommand(r.preCommand);
          message.success("已恢复默认");
        } catch (e: unknown) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const isEmpty = !preCommand.trim();

  const inner = (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      <Space wrap size="middle">
        <CodeOutlined />
        <Typography.Text strong>前置命令</Typography.Text>
        {isEmpty ? <Tag>空</Tag> : <Tag color="blue">已配置</Tag>}
        {!editing && (
          <Space size="small">
            <Button size="small" onClick={startEdit}>
              编辑
            </Button>
            <Button size="small" onClick={reset}>
              恢复默认
            </Button>
          </Space>
        )}
      </Space>
      {!editing ? (
        <Typography.Text
          code
          style={{ fontSize: 12, display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
        >
          {preCommand || "(空)"}
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            placeholder="例如 export http_proxy=http://127.0.0.1:1081"
          />
          <Space size="small">
            <Button size="small" type="primary" loading={saving} onClick={save}>
              保存
            </Button>
            <Button
              size="small"
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
            >
              取消
            </Button>
          </Space>
        </Space>
      )}
    </Space>
  );

  if (compact) return inner;
  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      {inner}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8, fontSize: 12 }}>
        每次启动训练 / 计算归一化时，会作为 <code>{"<前置命令> && uv run ..."}</code> 的形式拼接到容器命令最前面。
      </Typography.Paragraph>
    </Card>
  );
}
