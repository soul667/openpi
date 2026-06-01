import { useEffect, useState } from "react";
import { Button, Card, Descriptions, Modal, Space, Typography, message } from "antd";
import { CopyOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { JobRecord } from "../api/types";
import { JobStatusTag } from "../components/JobStatusTag";
import { LogTerminal } from "../components/LogTerminal";

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobRecord | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchJob = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const all = await api.getJobs();
      setJob(all.find((j) => j.id === id) || null);
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJob();
    const t = setInterval(fetchJob, 4000);
    return () => clearInterval(t);
  }, [id]);

  const handleKill = () => {
    if (!job) return;
    Modal.confirm({
      title: `Kill job ${job.id}?`,
      okType: "danger",
      onOk: async () => {
        try {
          await api.killJob(job.id);
          message.success("kill signal sent");
          fetchJob();
        } catch (e: unknown) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const copyPath = () => {
    if (!job) return;
    navigator.clipboard.writeText(job.logFile).then(() => message.success("copied"));
  };

  if (!id) return null;
  const isActive = job?.status === "running" || job?.status === "queued";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <Card
        size="small"
        title={
          <Space>
            <span>{job?.id || id}</span>
            {job && <JobStatusTag status={job.status} className={isActive ? "pulse" : ""} />}
          </Space>
        }
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchJob} loading={loading}>
              Refresh
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={copyPath}>
              Copy log path
            </Button>
            {isActive && (
              <Button size="small" danger icon={<StopOutlined />} onClick={handleKill}>
                Kill
              </Button>
            )}
          </Space>
        }
      >
        {job && (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Kind">{job.kind}</Descriptions.Item>
            <Descriptions.Item label="Config">{job.configName}</Descriptions.Item>
            <Descriptions.Item label="Exp">{job.expName || "-"}</Descriptions.Item>
            <Descriptions.Item label="Repo">{job.repoId || "-"}</Descriptions.Item>
            <Descriptions.Item label="Target">{job.targetLabel || job.targetHostId || "Local"}</Descriptions.Item>
            <Descriptions.Item label="NaN restarts">{job.autoRestartCount ?? 0}</Descriptions.Item>
            <Descriptions.Item label="Created">
              {new Date(job.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Started">
              {job.startedAt ? new Date(job.startedAt).toLocaleString() : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="Finished">
              {job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "-"}
            </Descriptions.Item>
            <Descriptions.Item label="Exit code">
              {job.exitCode === undefined || job.exitCode === null ? "-" : String(job.exitCode)}
            </Descriptions.Item>
            <Descriptions.Item label="PID">{job.pid ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="Log file">
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {job.logFile}
              </Typography.Text>
            </Descriptions.Item>
            {job.remoteLogFile && (
              <Descriptions.Item label="Remote log">
                <Typography.Text code copyable style={{ fontSize: 12 }}>
                  {job.remoteLogFile}
                </Typography.Text>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Command" span={2}>
              <pre
                style={{
                  margin: 0,
                  fontSize: 11,
                  maxHeight: 120,
                  overflow: "auto",
                  background: "#f6f8fa",
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                {job.command}
              </pre>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>
      <Card
        size="small"
        title="Live log"
        styles={{ body: { padding: 0, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }}
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      >
        <LogTerminal jobId={id} />
      </Card>
    </div>
  );
}
