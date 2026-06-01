import { useEffect, useState } from "react";
import { Layout, Menu, Space } from "antd";
import {
  DatabaseOutlined,
  RocketOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { DatasetPicker } from "./pages/DatasetPicker";
import { TrainLauncher } from "./pages/TrainLauncher";
import { JobList } from "./pages/JobList";
import { JobDetail } from "./pages/JobDetail";
import { ActiveJobPill } from "./components/ActiveJobPill";
import { GpuHeaderStrip } from "./components/GpuHeaderStrip";
import { startJobsPolling } from "./store/jobs";

const { Sider, Header, Content } = Layout;

const items = [
  { key: "/datasets", icon: <DatabaseOutlined />, label: <Link to="/datasets">Datasets</Link> },
  { key: "/train", icon: <RocketOutlined />, label: <Link to="/train">Train</Link> },
  { key: "/jobs", icon: <UnorderedListOutlined />, label: <Link to="/jobs">Jobs</Link> },
];

export default function App() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const selectedKey = "/" + (location.pathname.split("/")[1] || "datasets");

  useEffect(() => {
    startJobsPolling();
  }, []);

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="dark">
        <div
          style={{
            color: "#fff",
            fontWeight: 600,
            padding: "16px",
            fontSize: collapsed ? 14 : 16,
            letterSpacing: 0.5,
          }}
        >
          {collapsed ? "π" : "openpi UI"}
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <div style={{ fontWeight: 600 }}>openpi training console</div>
          <Space size="middle">
            <GpuHeaderStrip />
            <ActiveJobPill />
          </Space>
        </Header>
        <Content style={{ padding: 16, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <Routes>
            <Route path="/" element={<Navigate to="/datasets" replace />} />
            <Route path="/datasets" element={<DatasetPicker />} />
            <Route path="/train" element={<TrainLauncher />} />
            <Route path="/jobs" element={<JobList />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
