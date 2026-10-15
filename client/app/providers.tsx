"use client";

import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import { Box, Button, Container, CssBaseline, Stack, ThemeProvider, Typography, createTheme } from "@mui/material";
import { useClerk } from "@clerk/nextjs";
import type { ReactNode } from "react";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#176b53", dark: "#0d4e3b", light: "#dcefe6" },
    secondary: { main: "#c85d3b" },
    background: { default: "#f4f7f4", paper: "#ffffff" },
    text: { primary: "#182820", secondary: "#64736b" },
    divider: "#dce5df",
    error: { main: "#b43b35" },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Avenir Next", "Segoe UI Variable", "Segoe UI", sans-serif',
    h1: { fontSize: "1.55rem", fontWeight: 700 },
    h2: { fontSize: "1.2rem", fontWeight: 650 },
    h3: { fontSize: "1rem", fontWeight: 650 },
    button: { fontWeight: 650, textTransform: "none" },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { styleOverrides: { root: { border: "1px solid #dce5df" } } },
    MuiPaper: { styleOverrides: { outlined: { borderColor: "#dce5df" } } },
  },
});

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}

function ClerkActions() {
  const { openSignIn, openSignUp } = useClerk();

  return (
    <Stack spacing={1.25}>
      <Button variant="contained" onClick={() => openSignIn()}>Sign in</Button>
      <Button variant="outlined" onClick={() => openSignUp()}>Create account</Button>
    </Stack>
  );
}

export function AuthenticationPrompt({ clerkConfigured = true }: { clerkConfigured?: boolean }) {
  return (
    <Box component="main" sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", px: 2 }}>
      <Container maxWidth="xs">
        <Stack spacing={2.5} sx={{ textAlign: "center", alignItems: "stretch" }}>
          <Typography component="h1" variant="h1">Magnify</Typography>
          <Typography color="text.secondary">Sign in to your workspace.</Typography>
          {clerkConfigured ? <ClerkActions /> : <Typography color="error.main">Authentication is not configured.</Typography>}
        </Stack>
      </Container>
    </Box>
  );
}