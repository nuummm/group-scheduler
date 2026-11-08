import "./globals.css";
import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { PageLoading } from "./_components/PageState";
import { loadAppConfig } from "./_lib/app-config";
import { AppShell } from "./_shell/AppShell";
import AttendancePage from "./attendance/page";
import { AppErrorBoundary } from "./error";
import NotFound from "./not-found";
import HomePage from "./page";

// 日程調整の画面は開いたときに読む。在室の表示 PC や一覧だけを開く人に、
// 使わない画面のコードまで最初に落とさせない。
const EventPage = lazy(() => import("./events/[slug]/page"));

/** 別の画面へ移ったら先頭から見せる。戻る・進むのときはブラウザの位置に任せる。 */
function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 画面が変わったこと（pathname）が合図
  useEffect(() => {
    if (navigationType !== "POP") {
      window.scrollTo(0, 0);
    }
  }, [pathname, navigationType]);
  return null;
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html に #root がありません。");
}

void loadAppConfig().then(() =>
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <ScrollToTop />
        <AppErrorBoundary>
          <AppShell>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/attendance" element={<AttendancePage />} />
                <Route path="/events/:slug" element={<EventPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </AppShell>
        </AppErrorBoundary>
      </BrowserRouter>
    </StrictMode>,
  ),
);
