import { useEffect, useState } from "react";
import { Button, Modal, Space, Table, Tag, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { JobRecord } from "../api/types";
import { JobStatusTag } from "../components/JobStatusTag";
import { RerunModal } from "../components/RerunModal";
import { useJobsStore } from "../store/jobs";

function fmtTime(ms?: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function fmtDuration(start?: number, end?: number) {
  if (!start) return "-";
  const ms = (end || Date.now()) - start;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function JobList() {
  const navigate = useNavigate();
  const jobs = useJobsStore((s) => s.jobs);
  const fetchJobs = useJobsStore((s) => s.fetchJobs);
  const [rerunTarget, setRerunTarget] = useState<JobRecord | null>(null);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const handleKill = (job: JobRecord) => {
    Modal.confirm({
      title: `Kill job ${job.id}?`,
      content: `This will pkill the running ${job.kind} process inside the container.`,
      okType: "danger",
      onOk: async () => {
        try {
          await api.killJob(job.id);
          message.success("kill signal sent");
          fetchJobs();
        } catch (e: unknown) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const columns = [
    {
      title: "Status",
      key: "status",
      width: 110,
      render: (_: unknown, j: JobRecord) => <JobStatusTag status={j.status} />,
    },
    { title: "Kind", dataIndex: "kind", key: "kind", width: 100, render: (k: string) => <Tag>{k}</Tag> },
    { title: "Config", dataIndex: "configName", key: "configName" },
    {
      title: "Exp / Repo",
      key: "expRepo",
      render: (_: unknown, j: JobRecord) => (
        <span style={{ fontSize: 12 }}>
          {j.expName && <div>{j.expName}</div>}
          {j.repoId && <div style={{ color: "#888" }}>{j.repoId}</div>}
        </span>
      ),
    },
    { title: "Created", key: "created", render: (_: unknown, j: JobRecord) => fmtTime(j.createdAt) },
    {
      title: "Duration",
      key: "duration",
      render: (_: unknown, j: JobRecord) => fmtDuration(j.startedAt, j.finishedAt),
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, j: JobRecord) => (
        <Space>
          <Button size="small" onClick={() => navigate(`/jobs/${j.id}`)}>
            View
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setRerunTarget(j)}>
            Rerun
          </Button>
          {(j.status === "running" || j.status === "queued") && (
            <Button size="small" danger onClick={() => handleKill(j)}>
              Kill
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <Table
        dataSource={jobs}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20 }}
        rowClassName={(j) =>
          j.status === "running" || j.status === "queued" ? "active-row" : ""
        }
      />
      <RerunModal
        job={rerunTarget}
        onClose={() => setRerunTarget(null)}
        onLaunched={(launched) => {
          setRerunTarget(null);
          fetchJobs();
          navigate(`/jobs/${launched.id}`);
        }}
      />
    </>
  );
}
