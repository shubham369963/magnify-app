"use client";

import { useEffect, useState } from "react";

const REVALIDATION_DEBOUNCE_MS = 1000;

export function usePageRevalidation() {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let lastRevalidation = 0;
    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRevalidation < REVALIDATION_DEBOUNCE_MS) return;
      lastRevalidation = now;
      setRevision((current) => current + 1);
    };

    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, []);

  return revision;
}