import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AuthProvider } from "./features/auth/AuthProvider";
import { AccessProvider } from "./features/configuracoes/access/AccessProvider";
import { ServiceError } from "./features/configuracoes/services/types";
import "./index.css";
import { reloadForNewBuild } from "./lib/staleBuild";
import { DATA_SOURCE } from "./features/configuracoes/services";

// Modo simulado = modo demonstração: as Solicitações Financeiras já abrem com dados fictícios em todas as etapas.
if (DATA_SOURCE === "mock") void import("./features/financeiro/demo").then((m) => m.semear());

// Deploy novo com a aba aberta: o Vite avisa quando um arquivo do build antigo não existe mais.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: {
    // Regra de negócio (ServiceError) não melhora tentando de novo; falha de rede ganha 1 nova tentativa.
    queries: { retry: (count, error) => !(error instanceof ServiceError) && count < 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <AccessProvider>
              <App />
            </AccessProvider>
          </AuthProvider>
          <Toaster position="top-right" richColors closeButton />
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);

// Avisa o index.html de que a aplicação subiu (desliga a tela de falha de carregamento).
(window as Window & { __appBooted?: boolean }).__appBooted = true;
