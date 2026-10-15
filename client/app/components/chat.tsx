"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import SendRounded from "@mui/icons-material/SendRounded";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import PersonOutlineRounded from "@mui/icons-material/PersonOutlineRounded";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import OpenInFullRounded from "@mui/icons-material/OpenInFullRounded";
import CloseFullscreenRounded from "@mui/icons-material/CloseFullscreenRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Avatar,
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import { backendGraphqlRequest, type TokenGetter } from "../lib/client";
import { cachedBackendGraphqlRequest, getCachedGraphqlResult, invalidateGraphqlCache } from "../lib/cache";
import { usePageRevalidation } from "../lib/use-page-revalidation";
import { MESSAGES_QUERY } from "../lib/graphql/queries/messages";
import { SEND_MESSAGE_MUTATION } from "../lib/graphql/mutations/send-message";
import type { StoredMessage, StoredSource } from "../lib/types";
import { formatDuration } from "../lib/format-duration";
import MarkdownContent from "./shared/markdown-content";

interface SourceDocument {
  pageContent?: string;
  metadata?: { source?: string; source_order?: number; section_title?: string; excerpt?: string; loc?: { pageNumber?: number }; preview_url?: string };
}

interface Message {
  id: string;
  role: "assistant" | "user";
  content: string;
  ragStrategy?: "vector" | "index_tree";
  responseDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  documents?: SourceDocument[];
  sources?: StoredSource[];
}

const EMPTY_MESSAGES: Message[] = [];
const MAX_STORED_REPLY_TIMINGS = 500;

interface StoredReplyTiming {
  fingerprint: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

function orderSources<T extends { source?: string; page?: number; source_order?: number; sourceOrder?: number }>(sources: T[]): T[] {
  return [...sources].sort((left, right) =>
    (left.page ?? Number.MAX_SAFE_INTEGER) - (right.page ?? Number.MAX_SAFE_INTEGER)
    || (left.source ?? '').localeCompare(right.source ?? '')
    || (left.source_order ?? left.sourceOrder ?? Number.MAX_SAFE_INTEGER)
      - (right.source_order ?? right.sourceOrder ?? Number.MAX_SAFE_INTEGER),
  );
}

interface ChatProps {
  projectId: string;
  userId: string;
  conversationId: string;
  getToken: TokenGetter;
  indexing: boolean;
  sendDisabledReason?: string;
  onMessagesChanged: () => void;
}

interface ChatComposerProps {
  pending: boolean;
  indexing: boolean;
  loading: boolean;
  sendDisabledReason?: string;
  error: string;
  onSend: (query: string) => Promise<boolean>;
}

function toMessages(rows: StoredMessage[]): Message[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    ragStrategy: row.metadata?.rag_strategy,
    sources: orderSources(row.metadata?.sources ?? []),
  }));
}

function replyTimingsStorageKey(projectId: string, conversationId: string) {
  return `magnify:reply-timings:${projectId}:${conversationId}`;
}

function readReplyTimings(key: string): StoredReplyTiming[] {
  try {
    const value = localStorage.getItem(key);
    const records = value ? JSON.parse(value) as StoredReplyTiming[] : [];
    return Array.isArray(records)
      ? records.filter((record) => typeof record.fingerprint === "string" && Number.isFinite(record.durationMs))
      : [];
  } catch {
    return [];
  }
}

async function replyFingerprint(question: string, answer: string): Promise<string> {
  const input = new TextEncoder().encode(`${question}\0${answer}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rememberReplyTiming(
  projectId: string,
  conversationId: string,
  question: string,
  answer: string,
  durationMs: number,
  inputTokens?: number | null,
  outputTokens?: number | null,
): Promise<void> {
  try {
    const key = replyTimingsStorageKey(projectId, conversationId);
    const fingerprint = await replyFingerprint(question, answer);
    const records = readReplyTimings(key);
    records.push({
      fingerprint,
      durationMs,
      ...(inputTokens == null ? {} : { inputTokens }),
      ...(outputTokens == null ? {} : { outputTokens }),
    });
    localStorage.setItem(key, JSON.stringify(records.slice(-MAX_STORED_REPLY_TIMINGS)));
  } catch {
    // Reply timing remains available for the current view if browser storage is unavailable.
  }
}

async function restoreReplyTimings(
  rows: StoredMessage[],
  projectId: string,
  conversationId: string,
): Promise<Message[]> {
  const records = readReplyTimings(replyTimingsStorageKey(projectId, conversationId));
  if (!records.length) return toMessages(rows);

  const timingsByFingerprint = new Map<string, StoredReplyTiming[]>();
  for (const record of records) {
    const timings = timingsByFingerprint.get(record.fingerprint) ?? [];
    timings.push(record);
    timingsByFingerprint.set(record.fingerprint, timings);
  }
  const occurrences = new Map<string, number>();
  const messages = toMessages(rows);
  let previousQuestion = "";
  for (const [index, row] of rows.entries()) {
    if (row.role === "user") {
      previousQuestion = row.content;
      continue;
    }
    if (!previousQuestion) continue;
    const fingerprint = await replyFingerprint(previousQuestion, row.content);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const timing = timingsByFingerprint.get(fingerprint)?.[occurrence];
    if (timing) {
      messages[index].responseDurationMs = timing.durationMs;
      messages[index].inputTokens = timing.inputTokens;
      messages[index].outputTokens = timing.outputTokens;
    }
  }
  return messages;
}

function ChatComposer({ pending, indexing, loading, sendDisabledReason, error, onSend }: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const disabled = pending || indexing || Boolean(sendDisabledReason) || loading;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = draft.trim();
    if (!query || disabled) return;
    setDraft("");
    if (!await onSend(query)) setDraft(query);
  }

  return (
    <Box component="form" onSubmit={(event) => void submit(event)} sx={{ flexShrink: 0, p: 1.25, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {(indexing || sendDisabledReason) && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>{indexing ? "PDFs are processing. Chat will be available when indexing finishes." : sendDisabledReason}</Typography>}
      <Stack direction="row" spacing={1} sx={{ alignItems: "end" }}>
        <TextField fullWidth size="small" multiline maxRows={5} aria-label="Message" placeholder={indexing ? "Wait for PDF indexing to finish" : sendDisabledReason || "Ask about this project"} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} sx={{ "& .MuiInputBase-input": { fontSize: "0.875rem", lineHeight: 1.45 } }} />
        <Tooltip title="Send message">
          <span><IconButton color="primary" type="submit" disabled={disabled || !draft.trim()} aria-label="Send message" sx={{ width: 48, height: 48, borderRadius: 1.5, bgcolor: "primary.main", color: "common.white", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}><SendRounded /></IconButton></span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

export default function Chat({ projectId, userId, conversationId, getToken, indexing, sendDisabledReason, onMessagesChanged }: ChatProps) {
  const pageRevision = usePageRevalidation();
  const activeKey = `${projectId}:${conversationId}`;
  const messageVariables = { projectId, conversationId };
  const cachedHistory = getCachedGraphqlResult<{ messages: StoredMessage[] }>(userId, MESSAGES_QUERY, messageVariables);
  const [history, setHistory] = useState<{
    key: string;
    messages: Message[];
    loading: boolean;
    error: string;
  }>({ key: "", messages: [], loading: true, error: "" });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; copied: boolean } | null>(null);
  const [activePreview, setActivePreview] = useState<{ url: string; title: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const activeHistory = history.key === activeKey
    ? history
    : cachedHistory
      ? { key: activeKey, messages: toMessages(cachedHistory.messages), loading: false, error: "" }
      : null;
  const messages = activeHistory?.messages ?? EMPTY_MESSAGES;
  const loading = !activeHistory || activeHistory.loading;
  const error = activeHistory?.error ?? "";
  const pending = pendingKey === activeKey;
  const endRef = useRef<HTMLDivElement>(null);

  async function copyAnswer(entry: Message) {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopyFeedback({ id: entry.id, copied: true });
    } catch {
      setCopyFeedback({ id: entry.id, copied: false });
    }
    window.setTimeout(() => {
      setCopyFeedback((current) => current?.id === entry.id ? null : current);
    }, 1800);
  }

  function renderPagePreview(url: string, title: string) {
    return (
      <Box>
        <Box sx={{ position: "relative", width: "100%", maxWidth: 420, mt: 1 }}>
          <Box
            component="iframe"
            src={url}
            title={title}
            loading="lazy"
            sx={{ display: "block", width: "100%", height: 360, border: 1, borderColor: "divider", borderRadius: 1, pointerEvents: "none" }}
          />
          <Tooltip title="Open full screen">
            <Box
              component="button"
              type="button"
              aria-label={`Open ${title} full screen`}
              onClick={() => setActivePreview({ url, title })}
              sx={{ position: "absolute", inset: 0, display: "flex", justifyContent: "flex-end", alignItems: "flex-start", width: "100%", p: 1, border: 0, bgcolor: "transparent", cursor: "zoom-in", "&:focus-visible": { outline: 2, outlineColor: "primary.main", outlineOffset: -2 }, "&:hover .preview-expand": { opacity: 1 } }}
            >
              <Box component="span" className="preview-expand" sx={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 1, bgcolor: "rgba(20, 28, 23, 0.78)", color: "common.white", opacity: 0.9, transition: "opacity 120ms ease" }}>
                <OpenInFullRounded fontSize="small" />
              </Box>
            </Box>
          </Tooltip>
        </Box>
        <Typography component="a" href={url} target="_blank" rel="noreferrer" variant="caption">
          Open PDF page in new tab
        </Typography>
      </Box>
    );
  }

  useEffect(() => {
    let current = true;
    cachedBackendGraphqlRequest<{ messages: StoredMessage[] }>(
      getToken,
      MESSAGES_QUERY,
      { projectId, conversationId },
      userId,
      undefined,
      [`project:${projectId}`, `workspace:${projectId}`, `messages:${projectId}:${conversationId}`],
    ).then(async ({ messages: rows }) => {
      const restoredMessages = await restoreReplyTimings(rows, projectId, conversationId);
      if (current) {
        setHistory({
          key: `${projectId}:${conversationId}`,
          messages: restoredMessages,
          loading: false,
          error: "",
        });
      }
    }).catch((cause: unknown) => {
      if (current) setHistory({
        key: `${projectId}:${conversationId}`,
        messages: [],
        loading: false,
        error: cause instanceof Error ? cause.message : "Could not load conversation history.",
      });
    });
    return () => { current = false; };
  }, [conversationId, getToken, pageRevision, projectId, userId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, pending]);

  async function send(query: string): Promise<boolean> {
    if (!query || pending || indexing || sendDisabledReason) return false;
    const temporaryId = `pending-${Date.now()}`;
    const requestStartedAt = performance.now();
    setHistory((current) => current.key === activeKey
      ? { ...current, error: "", messages: [...current.messages, { id: temporaryId, role: "user", content: query }] }
      : current);
    setPendingKey(activeKey);
    try {
      const { sendMessage: data } = await backendGraphqlRequest<{
        sendMessage: {
          message: string;
          ragStrategy: "vector" | "index_tree";
          inputTokens?: number | null;
          outputTokens?: number | null;
          sources: Array<{
            source?: string;
            sourceOrder?: number;
            sectionTitle?: string;
            page?: number;
            contentType?: string;
            content: string;
            excerpt?: string;
            previewUrl?: string;
          }>;
        };
      }>(getToken, SEND_MESSAGE_MUTATION, { projectId, conversationId, message: query });
      invalidateGraphqlCache([
        `messages:${projectId}:${conversationId}`,
        `workspace:${projectId}`,
      ]);
      const content = typeof data.message === "string" ? data.message : JSON.stringify(data.message ?? "");
      const responseDurationMs = performance.now() - requestStartedAt;
      await rememberReplyTiming(
        projectId,
        conversationId,
        query,
        content,
        responseDurationMs,
        data.inputTokens,
        data.outputTokens,
      );
      const documents: SourceDocument[] = orderSources(data.sources).map((source) => ({
        pageContent: source.content,
        metadata: {
          source: source.source,
          source_order: source.sourceOrder,
          section_title: source.sectionTitle,
          excerpt: source.excerpt,
          loc: source.page === undefined ? undefined : { pageNumber: source.page },
          preview_url: source.previewUrl,
        },
      }));
      setHistory((current) => current.key === activeKey
        ? { ...current, messages: [
            ...current.messages,
            {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content,
              ragStrategy: data.ragStrategy,
              responseDurationMs,
              inputTokens: data.inputTokens ?? undefined,
              outputTokens: data.outputTokens ?? undefined,
              documents,
            },
          ] }
        : current);
      onMessagesChanged();
      return true;
    } catch (cause) {
      try {
        invalidateGraphqlCache([`messages:${projectId}:${conversationId}`]);
        const { messages: rows } = await cachedBackendGraphqlRequest<{ messages: StoredMessage[] }>(
          getToken,
          MESSAGES_QUERY,
          { projectId, conversationId },
          userId,
          undefined,
          [`project:${projectId}`, `workspace:${projectId}`, `messages:${projectId}:${conversationId}`],
        );
        const latestUserIndex = rows.reduce(
          (latest, row, index) => row.role === "user" ? index : latest,
          -1,
        );
        if (latestUserIndex >= 0
          && rows[latestUserIndex]?.content === query
          && rows[latestUserIndex + 1]?.role === "assistant") {
          const restoredMessages = await restoreReplyTimings(rows, projectId, conversationId);
          setHistory({
            key: activeKey,
            messages: restoredMessages,
            loading: false,
            error: "",
          });
          invalidateGraphqlCache([`workspace:${projectId}`]);
          onMessagesChanged();
          return true;
        }
      } catch {
        // Preserve the original chat error if history also cannot be loaded.
      }
      setHistory((current) => current.key === activeKey
        ? {
            ...current,
            error: cause instanceof Error ? cause.message : "Chat failed. Please try again.",
            messages: current.messages.filter((entry) => entry.id !== temporaryId),
          }
        : current);
      return false;
    } finally {
      setPendingKey((current) => current === activeKey ? null : current);
    }
  }

  return (
    <Paper variant="outlined" sx={{ position: expanded ? "fixed" : "relative", inset: expanded ? 0 : "auto", zIndex: expanded ? 1300 : "auto", width: expanded ? "100vw" : "100%", height: expanded ? "100dvh" : { xs: "calc(100dvh - 8rem)", md: "calc(100dvh - 6rem)" }, minHeight: expanded ? 0 : 420, display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: expanded ? 0 : undefined }}>
      <Box sx={{ flexShrink: 0, px: 2.25, py: 1.25, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h3">Conversation</Typography>
          <Typography variant="caption" color="text.secondary">Answers are grounded in this project&apos;s PDFs</Typography>
        </Box>
        <Tooltip title={expanded ? "Exit full screen chat" : "Expand chat"}>
          <IconButton aria-label={expanded ? "Exit full screen chat" : "Expand chat"} onClick={() => setExpanded((current) => !current)}>
            {expanded ? <CloseFullscreenRounded /> : <OpenInFullRounded />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box role="log" aria-live="polite" aria-label="Chat messages" sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: { xs: 1.5, sm: 2.25 }, py: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
        {loading ? (
          <Stack role="status" spacing={1} sx={{ flex: 1, alignItems: "center", justifyContent: "center", color: "text.secondary" }}><CircularProgress size={24} /><Typography variant="body2">Loading conversation</Typography></Stack>
        ) : messages.length === 0 ? (
          <Stack spacing={1} sx={{ flex: 1, alignItems: "center", justifyContent: "center", color: "text.secondary", textAlign: "center" }}>
            <ChatBubbleOutlineRounded sx={{ fontSize: 32, color: "primary.main" }} />
            <Typography variant="h3">Ask your first question</Typography>
            <Typography variant="body2">Upload PDFs to this project, then ask for summaries or evidence.</Typography>
          </Stack>
        ) : messages.map((entry) => (
          <Stack key={entry.id} direction="row" spacing={0.75} sx={{ alignSelf: entry.role === "user" ? "flex-end" : "flex-start", maxWidth: "min(96%, 920px)", flexDirection: entry.role === "user" ? "row-reverse" : "row", alignItems: "flex-start" }}>
            <Avatar sx={{ width: 24, height: 24, bgcolor: entry.role === "user" ? "secondary.main" : "primary.main" }}>
              {entry.role === "user" ? <PersonOutlineRounded sx={{ fontSize: 18 }} /> : <SmartToyOutlined sx={{ fontSize: 18 }} />}
            </Avatar>
            <Paper variant="outlined" sx={{ px: 1.25, py: 0.9, minWidth: 80, bgcolor: entry.role === "user" ? "#f0f5f1" : "#fbfdfb", borderColor: entry.role === "assistant" ? "#d8e5dc" : "divider", overflowWrap: "anywhere" }}>
              <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>{entry.role === "user" ? "You" : "Magnify"}</Typography>
                {entry.role === "assistant" && entry.ragStrategy && (
                  <Typography variant="caption" color="text.secondary" sx={{ mr: "auto", ml: 1 }}>
                    {entry.ragStrategy === "index_tree" ? "Index Tree" : "Vector"}
                  </Typography>
                )}
                {entry.role === "assistant" && (
                  <Tooltip title={copyFeedback?.id === entry.id ? (copyFeedback.copied ? "Copied answer" : "Clipboard unavailable") : "Copy answer"}>
                    <IconButton size="small" aria-label="Copy answer" onClick={() => void copyAnswer(entry)} sx={{ width: 30, height: 30, color: "text.secondary" }}>
                      {copyFeedback?.id === entry.id && copyFeedback.copied ? <CheckRounded fontSize="small" /> : <ContentCopyRounded fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
              {entry.role === "assistant"
                ? <MarkdownContent content={entry.content} />
                : <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", fontSize: "0.8125rem", lineHeight: 1.5 }}>{entry.content}</Typography>}
              {entry.role === "assistant" && entry.responseDurationMs !== undefined && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                  Reply time {formatDuration(entry.responseDurationMs)}
                  {` · Input ${entry.inputTokens?.toLocaleString() ?? "N/A"} tokens`}
                  {` · Output ${entry.outputTokens?.toLocaleString() ?? "N/A"} tokens`}
                  {` · Total ${entry.inputTokens !== undefined && entry.outputTokens !== undefined
                    ? (entry.inputTokens + entry.outputTokens).toLocaleString()
                    : "N/A"} tokens`}
                </Typography>
              )}
            {Boolean(entry.documents?.length || entry.sources?.length) && (
              <Accordion
                disableGutters
                elevation={0}
                expanded={expandedSources[`${activeKey}:${entry.id}`] ?? false}
                onChange={(_, isExpanded) => setExpandedSources((current) => ({
                  ...current,
                  [`${activeKey}:${entry.id}`]: isExpanded,
                }))}
                sx={{ mt: 1, border: 0, bgcolor: "transparent", "&:before": { display: "none" } }}
              >
                <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ minHeight: 36, px: 0, "& .MuiAccordionSummary-content": { my: 0.5 } }}>
                  <Typography variant="caption" sx={{ fontWeight: 700 }}>Sources ({entry.documents?.length || entry.sources?.length})</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0, pt: 0, display: "grid", gap: 1 }}>
                  {entry.documents?.map((document, sourceIndex) => (
                    <Box key={sourceIndex} sx={{ borderLeft: 2, borderColor: "primary.main", pl: 1 }}>
                      <Typography variant="caption" sx={{ fontWeight: 700 }}>
                        {document.metadata?.source?.split(/[\\/]/).pop() || "PDF"}{document.metadata?.loc?.pageNumber ? `, Page ${document.metadata.loc.pageNumber}` : ""}{document.metadata?.section_title ? ` · ${document.metadata.section_title}` : ""}
                      </Typography>
                      {document.metadata?.excerpt && document.metadata.excerpt !== document.pageContent && (
                        <Box sx={{ mt: 0.75 }}>
                          <Typography variant="caption" color="text.secondary">Matched excerpt</Typography>
                          <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}><MarkdownContent content={document.metadata.excerpt} /></Box>
                        </Box>
                      )}
                      {document.pageContent && (
                        <Box sx={{ mt: 0.75 }}>
                          {document.metadata?.excerpt !== document.pageContent && <Typography variant="caption" color="text.secondary">Full passage</Typography>}
                          <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}><MarkdownContent content={document.pageContent} /></Box>
                        </Box>
                      )}
                      {document.metadata?.preview_url && (
                        renderPagePreview(document.metadata.preview_url, `Preview of ${document.metadata.source || "PDF"}, page ${document.metadata.loc?.pageNumber ?? ""}`)
                      )}
                    </Box>
                  ))}
                  {entry.sources?.map((source, sourceIndex) => (
                    <Box key={`saved-${sourceIndex}`}>
                      <Typography variant="caption" sx={{ fontWeight: 700 }}>
                        {source.source || "PDF"}{source.page ? `, Page ${source.page}` : ""}{source.section_title ? ` · ${source.section_title}` : ""}
                      </Typography>
                      {source.excerpt && source.excerpt !== source.content && (
                        <Box sx={{ mt: 0.75 }}>
                          <Typography variant="caption" color="text.secondary">Matched excerpt</Typography>
                          <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}><MarkdownContent content={source.excerpt} /></Box>
                        </Box>
                      )}
                      {(source.content || source.excerpt) && (
                        <Box sx={{ mt: 0.75 }}>
                          {source.excerpt !== source.content && <Typography variant="caption" color="text.secondary">Full passage</Typography>}
                          <Box sx={{ p: 1, borderRadius: 1, bgcolor: "action.hover" }}><MarkdownContent content={source.content ?? source.excerpt ?? ""} /></Box>
                        </Box>
                      )}
                      {source.preview_url && (
                        renderPagePreview(source.preview_url, `Preview of ${source.source || "PDF"}, page ${source.page ?? ""}`)
                      )}
                    </Box>
                  ))}
                </AccordionDetails>
              </Accordion>
            )}
            </Paper>
          </Stack>
        ))}
        {pending && <Stack direction="row" spacing={1} role="status" sx={{ alignItems: "center", color: "text.secondary" }}><CircularProgress size={16} /><Typography variant="caption">Thinking...</Typography></Stack>}
        <div ref={endRef} />
      </Box>
      <Dialog fullScreen open={Boolean(activePreview)} onClose={() => setActivePreview(null)} sx={{ zIndex: 1501 }}>
        <DialogTitle component="div" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexShrink: 0 }}>
          <Typography component="span" variant="h3" sx={{ overflowWrap: "anywhere" }}>{activePreview?.title}</Typography>
          <Tooltip title="Close preview">
            <IconButton aria-label="Close full-screen preview" onClick={() => setActivePreview(null)}>
              <CloseRounded />
            </IconButton>
          </Tooltip>
        </DialogTitle>
        <DialogContent sx={{ display: "flex", flex: "1 1 auto", minHeight: 0, p: 0, overflow: "hidden", bgcolor: "#171c19" }}>
          {activePreview && <Box component="iframe" src={activePreview.url} title={activePreview.title} sx={{ display: "block", width: "100%", height: "100%", border: 0 }} />}
        </DialogContent>
      </Dialog>
      <ChatComposer
        pending={pending}
        indexing={indexing}
        loading={loading}
        sendDisabledReason={sendDisabledReason}
        error={error}
        onSend={send}
      />
    </Paper>
  );
}