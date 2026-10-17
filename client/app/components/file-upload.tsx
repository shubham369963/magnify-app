"use client";

import { useEffect, useRef, useState } from "react";
import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import CloudUploadOutlined from "@mui/icons-material/CloudUploadOutlined";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { backendGraphqlRequest, backendRequest, type TokenGetter } from "../lib/client";
import { UPLOAD_STATUS_QUERY } from "../lib/graphql/queries/upload-status";
import { formatDuration } from "../lib/format-duration";

const DEFAULT_MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;
const configuredMaxPdfSizeBytes = process.env.NEXT_PUBLIC_MAX_PDF_SIZE_BYTES?.trim();
const MAX_PDF_SIZE_BYTES = configuredMaxPdfSizeBytes
  ? Number(configuredMaxPdfSizeBytes)
  : DEFAULT_MAX_PDF_SIZE_BYTES;
if (!Number.isSafeInteger(MAX_PDF_SIZE_BYTES) || MAX_PDF_SIZE_BYTES < 1) {
  throw new Error("NEXT_PUBLIC_MAX_PDF_SIZE_BYTES must be a positive integer.");
}
const maxPdfSizeLabel = `${Number((MAX_PDF_SIZE_BYTES / (1024 * 1024)).toFixed(2))} MB`;

interface FileUploadProps {
  projectId: string;
  indexing?: boolean;
  deletedDocumentIds?: ReadonlySet<string>;
  getToken: TokenGetter;
  onUploaded: () => void;
}

interface UploadItem {
  key: string;
  fileName: string;
  jobId?: string;
  status: "uploading" | "queued" | "processing" | "completed" | "failed";
  error?: string;
  uploadDurationMs?: number;
  indexStartedAt?: number;
  indexDurationMs?: number;
}

function uploadStorageKey(projectId: string) {
  return `magnify:upload-timings:${projectId}`;
}

export default function FileUpload({ projectId, indexing = false, deletedDocumentIds, getToken, onUploaded }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const uploadsRef = useRef(uploads);
  const onUploadedRef = useRef(onUploaded);
  const pollingRef = useRef(false);
  const notifiedJobsRef = useRef(new Set<string>());
  const processing = indexing || uploads.some((item) => item.status === "uploading" || item.status === "queued" || item.status === "processing");
  const uploadDisabled = uploading || processing || loadedStorageKey !== uploadStorageKey(projectId);

  uploadsRef.current = uploads;
  onUploadedRef.current = onUploaded;

  useEffect(() => {
    const key = uploadStorageKey(projectId);
    try {
      const stored = localStorage.getItem(key);
      const items = stored ? JSON.parse(stored) as UploadItem[] : [];
      setUploads(Array.isArray(items) ? items.map((item) => item.status === "uploading"
        ? { ...item, status: "failed", error: "Upload was interrupted. Please upload the PDF again." }
        : item) : []);
    } catch {
      setUploads([]);
    }
    setLoadedStorageKey(key);
  }, [projectId]);

  useEffect(() => {
    if (!deletedDocumentIds?.size) return;
    setUploads((current) => current.some((item) => item.jobId && deletedDocumentIds.has(item.jobId))
      ? current.filter((item) => !item.jobId || !deletedDocumentIds.has(item.jobId))
      : current);
  }, [deletedDocumentIds, loadedStorageKey]);

  useEffect(() => {
    const key = uploadStorageKey(projectId);
    if (loadedStorageKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(uploads.filter((item, index) =>
        item.status === "uploading" || item.status === "queued" || item.status === "processing" || index >= uploads.length - 20,
      )));
    } catch {
      // Keep timing display usable if browser storage is unavailable or full.
    }
  }, [loadedStorageKey, projectId, uploads]);

  useEffect(() => {
    let stopped = false;
    const removeDeletedUpload = (upload: UploadItem) => {
      setUploads((current) => current.filter((item) => item.key !== upload.key));
      if (upload.jobId && !notifiedJobsRef.current.has(upload.jobId)) {
        notifiedJobsRef.current.add(upload.jobId);
        onUploadedRef.current();
      }
    };
    const checkStatus = async () => {
      if (pollingRef.current || stopped) return;
      const pending = uploadsRef.current.filter((upload) =>
        upload.jobId && (upload.status === "queued" || upload.status === "processing"),
      );
      if (!pending.length) return;
      pollingRef.current = true;
      try {
        await Promise.all(pending.map(async (upload) => {
          try {
            const { uploadStatus: result } = await backendGraphqlRequest<{
              uploadStatus: { status: UploadItem["status"] | "deleted"; error?: string | null };
            }>(getToken, UPLOAD_STATUS_QUERY, { jobId: upload.jobId });
            if (stopped) return;
            const status = result.status;
            if (status === "deleted") {
              removeDeletedUpload(upload);
              return;
            }
            const statusError = result.error ?? undefined;
            setUploads((current) => current.map((item) => item.key === upload.key
              ? {
                  ...item,
                  status,
                  error: statusError,
                  ...(item.indexStartedAt === undefined
                    ? {}
                    : { indexDurationMs: Math.max(0, Date.now() - item.indexStartedAt) }),
                }
              : item));
            if ((status === "completed" || status === "failed") && !notifiedJobsRef.current.has(upload.jobId!)) {
              notifiedJobsRef.current.add(upload.jobId!);
              onUploadedRef.current();
            }
          } catch (cause) {
            if (!stopped) {
              // Older APIs report deleted uploads as not found rather than "deleted".
              if (cause instanceof Error && cause.message === "Upload job not found.") {
                removeDeletedUpload(upload);
                return;
              }
              setUploads((current) => current.map((item) => item.key === upload.key
                ? { ...item, error: "Status check failed; retrying." }
                : item));
            }
          }
        }));
      } finally {
        pollingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void checkStatus(), 1400);
    void checkStatus();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [getToken, projectId]);

  async function upload(files: FileList | null) {
    if (!files?.length || uploadDisabled) return;
    setError("");
    const selected = Array.from(files);
    const accepted = selected.filter((file) =>
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    const rejected = selected.filter((file) => !accepted.includes(file));
    if (rejected.length) setError(`${rejected.map((file) => file.name).join(", ")}: select PDF files only.`);
    const oversized = accepted.filter((file) => file.size >= MAX_PDF_SIZE_BYTES);
    const validFiles = accepted.filter((file) => file.size < MAX_PDF_SIZE_BYTES);
    if (oversized.length) {
      setError((current) => [
        current,
        `${oversized.map((file) => file.name).join(", ")}: each PDF must be smaller than ${maxPdfSizeLabel}.`,
      ].filter(Boolean).join(" "));
    }
    if (!validFiles.length) {
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setUploading(true);
    const batch = validFiles.map((file, index) => ({
      file,
      key: `${Date.now()}-${index}-${file.name}`,
    }));
    setUploads((current) => [
      ...current,
      ...batch.map(({ file, key }) => ({ key, fileName: file.name, status: "uploading" as const })),
    ]);

    for (const { file, key } of batch) {
      try {
        const form = new FormData();
        form.append("pdf", file);
        const uploadStartedAt = performance.now();
        const result = await backendRequest<{ jobId: string }>(
          getToken,
          `projects/${encodeURIComponent(projectId)}/documents`,
          { method: "POST", body: form },
        );
        const queuedAt = performance.now();
        setUploads((current) => current.map((item) => item.key === key
          ? {
              ...item,
              jobId: result.jobId,
              status: "queued",
              error: undefined,
              uploadDurationMs: queuedAt - uploadStartedAt,
              indexStartedAt: Date.now(),
              indexDurationMs: 0,
            }
          : item));
        onUploaded();
      } catch (cause) {
        setUploads((current) => current.map((item) => item.key === key
          ? { ...item, status: "failed", error: cause instanceof Error ? cause.message : "Upload failed." }
          : item));
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <Box>
      <input ref={inputRef} hidden type="file" accept="application/pdf,.pdf" multiple disabled={uploadDisabled} aria-label="Select PDF files" onChange={(event) => void upload(event.target.files)} />
      <Button fullWidth variant="outlined" startIcon={uploading || processing ? <CircularProgress size={18} /> : <CloudUploadOutlined />} disabled={uploadDisabled} onClick={() => inputRef.current?.click()} sx={{ minHeight: 48, justifyContent: "flex-start", px: 1.75 }}>
        {uploading ? "Uploading PDFs..." : processing ? "Indexing PDFs..." : "Upload PDFs"}
      </Button>
      <Stack role="status" aria-live="polite" aria-busy={uploading || processing} spacing={0.75} sx={{ mt: 1.25 }}>
        {uploads.slice(-4).map((item) => (
          <Paper key={item.key} variant="outlined" sx={{ p: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
              {item.status === "completed" ? <CheckCircleOutlineRounded color="success" fontSize="small" /> : item.status === "failed" ? <ErrorOutlineRounded color="error" fontSize="small" /> : item.status === "uploading" || item.status === "processing" ? <CircularProgress size={16} /> : <InsertDriveFileOutlined color="action" fontSize="small" />}
              <Typography variant="body2" title={item.fileName} noWrap sx={{ minWidth: 0, flex: 1 }}>{item.fileName}</Typography>
              <Chip size="small" variant="outlined" label={item.status} color={item.status === "completed" ? "success" : item.status === "failed" ? "error" : "default"} />
              {(item.status === "completed" || item.status === "failed") && (
                <IconButton
                  size="small"
                  aria-label={`Dismiss ${item.fileName} upload status`}
                  title="Dismiss upload status"
                  onClick={() => setUploads((current) => current.filter((upload) => upload.key !== item.key))}
                >
                  <CloseRounded fontSize="small" />
                </IconButton>
              )}
            </Stack>
            {(item.uploadDurationMs !== undefined || item.indexDurationMs !== undefined) && (
              <Stack direction="row" spacing={1.25} sx={{ mt: 0.5, flexWrap: "wrap" }}>
                {item.uploadDurationMs !== undefined && (
                  <Typography variant="caption" color="text.secondary">
                    Upload {formatDuration(item.uploadDurationMs)}
                  </Typography>
                )}
                {item.indexDurationMs !== undefined && (
                  <Typography variant="caption" color="text.secondary">
                    Vector + Index Tree indexing {formatDuration(item.indexDurationMs)}
                    {item.status === "queued" || item.status === "processing" ? " elapsed" : " total"}
                  </Typography>
                )}
              </Stack>
            )}
            {item.error && <Typography variant="caption" color="error.main" sx={{ display: "block", mt: 0.5, overflowWrap: "anywhere" }}>{item.error}</Typography>}
          </Paper>
        ))}
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}