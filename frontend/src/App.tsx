import { Navigate, Route, Routes } from "react-router-dom";
import { DEMO } from "./api";
import { useAuth } from "./auth";
import Layout, { DemoBanner } from "./components/Layout";
import EvalsPage from "./pages/EvalsPage";
import Landing from "./pages/Landing";
import LoginPage from "./pages/LoginPage";
import ReviewPage from "./pages/ReviewPage";
import ReviewsPage from "./pages/ReviewsPage";
import RulesPage from "./pages/RulesPage";
import TracesPage from "./pages/TracesPage";
import WorkbenchPage from "./pages/WorkbenchPage";

export default function App() {
  const { user, loading } = useAuth();
  return (
    <>
      {DEMO && <DemoBanner />}
      <div className="app-body">
        {loading ? (
          <div className="empty">加载中…</div>
        ) : (
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={user ? <Navigate to="/workbench" replace /> : <LoginPage />} />
            {/* console routes: signed-out visitors sign in at the same URL, so deep links survive */}
            <Route element={user ? <Layout /> : <LoginPage />}>
              <Route path="/workbench" element={<WorkbenchPage />} />
              <Route path="/reviews" element={<ReviewsPage />} />
              <Route path="/reviews/:reviewId" element={<ReviewPage />} />
              <Route path="/rules" element={<RulesPage />} />
              <Route path="/evals" element={<EvalsPage />} />
              <Route path="/traces" element={<TracesPage />} />
              <Route path="/traces/:runId" element={<TracesPage />} />
            </Route>
            <Route path="*" element={<Navigate to={user ? "/workbench" : "/"} replace />} />
          </Routes>
        )}
      </div>
    </>
  );
}
