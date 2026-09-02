import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";
import { Toaster } from "sonner";

import { AuthProvider } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { ThemeProvider } from "@/app/providers/ThemeProvider";

export function AppProviders({ children }: PropsWithChildren): React.JSX.Element {
  const [queryClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          {children}
          <Toaster closeButton richColors position="bottom-right" />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
