import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "openpi-ui:wandb-key";

export function useWandbKey() {
  const [savedKey, setSavedKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(STORAGE_KEY) || "";
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSavedKey(e.newValue || "");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const saveKey = useCallback((value: string) => {
    const trimmed = (value || "").trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed);
      setSavedKey(trimmed);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      setSavedKey("");
    }
  }, []);

  const clearKey = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSavedKey("");
  }, []);

  return { savedKey, saveKey, clearKey };
}

export function useAutoSaveWandbKey(watchedValue: string | undefined, savedKey: string, saveKey: (v: string) => void) {
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const v = (watchedValue || "").trim();
    if (!v || v === savedKey) return;
    timerRef.current = window.setTimeout(() => {
      saveKey(v);
      timerRef.current = null;
    }, 500);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [watchedValue, savedKey, saveKey]);
}
