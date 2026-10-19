import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import EvalsPage from "./pages/EvalsPage";
import LoginPage from "./pages/LoginPage";
import ReviewPage from "./pages/ReviewPage";
import ReviewsPage from "./pages/ReviewsPage";
import RulesPage from "./pages/RulesPage";
import TracesPage from "./pages/TracesPage";
import WorkbenchPage from "./pages/WorkbenchPage";

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty">加载中…</div>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/reviews/:reviewId" element={<ReviewPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/evals" element={<EvalsPage />} />
        <Route path="/traces" element={<TracesPage />} />
        <Route path="/traces/:runId" element={<TracesPage />} />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Route>
    </Routes>
  );
}
