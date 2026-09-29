import { MaxUI } from "@maxhub/max-ui";
import "@maxhub/max-ui/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { installAnalytics } from "./analytics";
import App from "./app/App";
// «Синица» design system first; legacy surface styles follow until E2–E5 replace them.
import "./design/tokens.css";
import "./design/base.css";
import "./design/components/components.css";
import "./styles.css";
import "./admin.css";
import "./menu-experience.css";

const queryClient = new QueryClient();
installAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MaxUI>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </MaxUI>
  </StrictMode>,
);
