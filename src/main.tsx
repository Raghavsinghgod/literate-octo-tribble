import { Component, StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { RelightLoader } from "./components/RelightLoader";
import "./index.css";

const Landing = lazy(() => import("./pages/Landing.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Studio = lazy(() => import("./pages/Studio.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
          <p className="font-display text-lg font-semibold">Something went wrong</p>
          <p className="max-w-md break-words text-sm text-muted-foreground">
            {this.state.error.message || "Unexpected runtime error"}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Reload Relight
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<RelightLoader fullScreen label="Opening the studio…" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);

const boot = document.getElementById("boot-screen");
if (boot) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      boot.classList.add("boot-exit");
      setTimeout(() => boot.remove(), 600);
    }),
  );
}
