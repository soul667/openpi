import { useEffect, useState } from "react";
import { Button, Card, Input, Space, Tag, Typography, message } from "antd";
import { api } from "../api/client";

export function InferEnvCard({ compact = false }: { compact?: boolean }) {
  const [condaEnv, setCondaEnv] = useState("pi05-infer");
  const [inferPreCommand, setInferPreCommand] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      const r = await api.getInferSettings();
      setCondaEnv(r.condaEnv);
      setInferPreCommand(r.inferPreCommand);
    } catch (e: unknown) {
      message.error((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveInferSettings({ condaEnv, inferPreCommand });
      setCondaEnv(r.condaEnv);
      setInferPreCommand(r.inferPreCommand);
      message.success("推理环境已保存");
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const inner = (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Text strong>Conda 环境</Typography.Text>
        <Tag color="blue">{condaEnv}</Tag>
      </Space>
      <Input
        value={condaEnv}
        onChange={(e) => setCondaEnv(e.target.value)}
        placeholder="pi05-infer"
        addonBefore="conda -n"
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        参考 tools/zbl_dm：conda create -n pi05-infer python=3.11 &amp;&amp; pip install -r requirements.txt
      </Typography.Text>
      <Typography.Text strong>推理前置命令（可选）</Typography.Text>
      <Input.TextArea
        value={inferPreCommand}
        onChange={(e) => setInferPreCommand(e.target.value)}
        rows={2}
        placeholder="export http_proxy=..."
      />
      <Button type="primary" size="small" loading={saving} onClick={save}>
        保存
      </Button>
    </Space>
  );

  if (compact) return inner;
  return (
    <Card size="small" title="推理 Conda 环境">
      {inner}
    </Card>
  );
}