"use client";

import AddRounded from "@mui/icons-material/AddRounded";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import { UserButton, useAuth } from "@clerk/nextjs";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Chat from "./chat";
import FileUpload from "./file-upload";
import { backendGraphqlRequest } from "../lib/client";
import {
  cachedBackendGraphqlRequest,
  invalidateGraphqlCache,
} from "../lib/cache";
import { usePageRevalidation } from "../lib/use-page-revalidation";

interface Project {
  id: string;
  name: string;
  description: string | null;
  rag_strategy: "vector" | "index_tree";
  created_at: string;
  updated_at: string;
}

interface ProjectIndexTreeStatus {
  status: "pending" | "processing" | "completed" | "failed";
  progress: number | null;
  error_message: string | null;
  updated_at: string;
}

interface ProjectDocument {
  id: string;
  file_name: string;
  file_size: number;
  processing_status: "pending" | "processing" | "completed" | "failed";
  processing_error: string | null;
  created_at: string;
}

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

const CONVERSATION_PAGE_SIZE = 20;
const CONVERSATION_QUERY_LIMIT = CONVERSATION_PAGE_SIZE + 1;
const CONVERSATIONS_QUERY = `
  query Conversations($projectId: ID!, $limit: Int, $offset: Int) {
    conversations(projectId: $projectId, limit: $limit, offset: $offset) {
      id title updated_at
    }
  }
`;

type DeleteTarget =
  | { kind: "document"; id: string; label: string }
  | { kind: "conversation"; id: string; label: string };

export default function ProjectDetail({ projectId }: { projectId: string }) {
  const { getToken, userId } = useAuth();
  const searchParams = useSearchParams();
  const routeConversationId = searchParams.get("conversationId");
  const pageRevision = usePageRevalidation();
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationOffset, setConversationOffset] = useState(0);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [routedConversation, setRoutedConversation] = useState<{
    projectId: string;
    conversation: Conversation;
  } | null>(null);
  const [resolvedRouteKey, setResolvedRouteKey] = useState<string | null>(null);
  const routeConversationKey = routeConversationId
    ? `${projectId}:${routeConversationId}`
    : null;
  const listedRouteConversation = conversations.find(
    (conversation) => conversation.id === routeConversationId,
  );
  const routeConversationIsListed = Boolean(listedRouteConversation);
  const routedConversationMatches = routedConversation?.projectId === projectId
    && routedConversation.conversation.id === routeConversationId;
  const routeConversationUnresolved = Boolean(
    routeConversationKey
    && !routeConversationIsListed
    && !routedConversationMatches
    && resolvedRouteKey !== routeConversationKey,
  );
  const conversationId = routeConversationUnresolved
    ? null
    : routeConversationId && (routeConversationIsListed || routedConversationMatches)
      ? routeConversationId
      : (conversations[0]?.id ?? null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);
  const [treeRetrying, setTreeRetrying] = useState(false);
  const [treeStatus, setTreeStatus] = useState<ProjectIndexTreeStatus | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletedDocuments, setDeletedDocuments] = useState<{
    projectId: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  const deletedDocumentIdsRef = useRef(new Set<string>());
  const hasPendingDocuments = documents.some(
    (item) =>
      item.processing_status === "pending" ||
      item.processing_status === "processing",
  );
  const documentProcessingStatus = documents.some(
    (item) => item.processing_status === "processing",
  )
    ? "processing"
    : documents.some((item) => item.processing_status === "pending")
      ? "pending"
      : documents.some((item) => item.processing_status === "failed")
        ? "failed"
        : documents.length > 0 &&
            documents.every((item) => item.processing_status === "completed")
          ? "completed"
          : null;

  useEffect(() => {
    let current = true;
    Promise.all([
      cachedBackendGraphqlRequest<{ project: Project }>(
        getToken,
        `
        query Project($projectId: ID!) { project(projectId: $projectId) { id name description rag_strategy created_at updated_at } }
      `,
        { projectId },
        userId ?? "signed-out",
        undefined,
        [`project:${projectId}`, `workspace:${projectId}`],
      ),
      backendGraphqlRequest<{ documents: ProjectDocument[] }>(
        getToken,
        `
        query Documents($projectId: ID!, $limit: Int, $offset: Int) {
          documents(projectId: $projectId, limit: $limit, offset: $offset) {
            id file_name file_size processing_status processing_error created_at
          }
        }
      `,
        { projectId, limit: 100, offset: 0 },
      ),
      cachedBackendGraphqlRequest<{ conversations: Conversation[] }>(
        getToken,
        CONVERSATIONS_QUERY,
        { projectId, limit: CONVERSATION_QUERY_LIMIT, offset: 0 },
        userId ?? "signed-out",
        undefined,
        [`conversations:${projectId}`, `workspace:${projectId}`],
      ),
    ])
      .then(([projectResult, documentsResult, conversationsResult]) => {
        if (!current) return;
        const activeProject = projectResult.project;
        const documentRows = documentsResult.documents;
        const conversationRows = conversationsResult.conversations;
        setProject(activeProject);
        setDocuments(documentRows.filter((item) => !deletedDocumentIdsRef.current.has(item.id)));
        setConversations(conversationRows.slice(0, CONVERSATION_PAGE_SIZE));
        setConversationOffset(Math.min(conversationRows.length, CONVERSATION_PAGE_SIZE));
        setHasMoreConversations(conversationRows.length > CONVERSATION_PAGE_SIZE);
        setError(activeProject ? "" : "This project could not be found.");
      })
      .catch((cause: unknown) => {
        if (current) {
          setProject(null);
          setDocuments([]);
          setConversations([]);
          setConversationOffset(0);
          setHasMoreConversations(false);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load this project.",
          );
        }
      })
      .finally(() => {
        if (current) setLoadedProjectId(projectId);
      });
    return () => {
      current = false;
    };
  }, [getToken, pageRevision, projectId, revision, userId]);

  useEffect(() => {
    deletedDocumentIdsRef.current = new Set();
  }, [projectId]);

  useEffect(() => {
    if (loadedProjectId !== projectId || !routeConversationId) return;
    const key = `${projectId}:${routeConversationId}`;
    if (listedRouteConversation) return;
    if (resolvedRouteKey === key) return;

    let active = true;
    void backendGraphqlRequest<{ conversation: Conversation }>(
      getToken,
      `
      query Conversation($projectId: ID!, $conversationId: ID!) {
        conversation(projectId: $projectId, conversationId: $conversationId) {
          id title updated_at
        }
      }
    `,
      { projectId, conversationId: routeConversationId },
    )
      .then(({ conversation }) => {
        if (!active) return;
        setRoutedConversation({ projectId, conversation });
        setResolvedRouteKey(key);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setRoutedConversation(null);
        setResolvedRouteKey(key);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load the requested conversation.",
        );
      });
    return () => {
      active = false;
    };
  }, [
    getToken,
    loadedProjectId,
    projectId,
    resolvedRouteKey,
    routeConversationId,
    listedRouteConversation,
  ]);

  useEffect(() => {
    if (loadedProjectId !== projectId || !project) return;
    if (routeConversationUnresolved) return;
    const nextConversationId = conversations.some(
      (conversation) => conversation.id === routeConversationId,
    )
      ? routeConversationId
      : routedConversationMatches
        ? routeConversationId
      : (conversations[0]?.id ?? null);
    if (routeConversationId !== nextConversationId) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("projectId", projectId);
      if (nextConversationId) params.set("conversationId", nextConversationId);
      else params.delete("conversationId");
      window.history.replaceState(null, "", `/project?${params.toString()}`);
    }
  }, [
    conversations,
    loadedProjectId,
    project,
    projectId,
    routeConversationId,
    routeConversationUnresolved,
    routedConversationMatches,
    searchParams,
  ]);

  function navigateToConversation(conversationId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("projectId", projectId);
    params.set("conversationId", conversationId);
    const href = `/project?${params.toString()}`;
    window.history.pushState(null, "", href);
  }

  async function loadPreviousConversations() {
    if (loadingMoreConversations || !hasMoreConversations) return;
    setLoadingMoreConversations(true);
    setError("");
    try {
      const { conversations: rows } = await cachedBackendGraphqlRequest<{
        conversations: Conversation[];
      }>(
        getToken,
        CONVERSATIONS_QUERY,
        { projectId, limit: CONVERSATION_QUERY_LIMIT, offset: conversationOffset },
        userId ?? "signed-out",
        undefined,
        [`conversations:${projectId}`, `workspace:${projectId}`],
      );
      const nextPage = rows.slice(0, CONVERSATION_PAGE_SIZE);
      setConversations((current) => {
        const existingIds = new Set(current.map((conversation) => conversation.id));
        return [...current, ...nextPage.filter((conversation) => !existingIds.has(conversation.id))];
      });
      setConversationOffset((current) => current + nextPage.length);
      setHasMoreConversations(rows.length > CONVERSATION_PAGE_SIZE);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load previous conversations.",
      );
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  useEffect(() => {
    if (!documents.length) {
      return;
    }
    let active = true;
    let timer: number | undefined;
    const refreshStatus = async () => {
      try {
        const { projectIndexTreeStatus: status } = await backendGraphqlRequest<{
          projectIndexTreeStatus: ProjectIndexTreeStatus | null;
        }>(
          getToken,
          `
          query ProjectIndexTreeStatus($projectId: ID!) {
            projectIndexTreeStatus(projectId: $projectId) { status progress error_message updated_at }
          }
        `,
          { projectId },
        );
        if (!active) return;
        setTreeStatus(status);
        if (
          !status ||
          status.status === "pending" ||
          status.status === "processing"
        ) {
          timer = window.setTimeout(() => void refreshStatus(), 1800);
        }
      } catch {
        if (active) timer = window.setTimeout(() => void refreshStatus(), 4000);
      }
    };
    void refreshStatus();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [documents.length, getToken, projectId, revision]);

  useEffect(() => {
    if (!hasPendingDocuments) return;
    let active = true;
    let timer: number | undefined;
    const refreshDocuments = async () => {
      try {
        const { documents: rows } = await backendGraphqlRequest<{
          documents: ProjectDocument[];
        }>(
          getToken,
          `
          query Documents($projectId: ID!, $limit: Int, $offset: Int) {
            documents(projectId: $projectId, limit: $limit, offset: $offset) {
              id file_name file_size processing_status processing_error created_at
            }
          }
        `,
          { projectId, limit: 100, offset: 0 },
        );
        if (!active) return;
        setDocuments(rows.filter((item) => !deletedDocumentIdsRef.current.has(item.id)));
        if (
          rows.some(
            (item) =>
              item.processing_status === "pending" ||
              item.processing_status === "processing",
          )
        ) {
          timer = window.setTimeout(() => void refreshDocuments(), 1600);
        }
      } catch {
        if (active)
          timer = window.setTimeout(() => void refreshDocuments(), 4000);
      }
    };
    timer = window.setTimeout(() => void refreshDocuments(), 1000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [getToken, hasPendingDocuments, projectId]);

  async function changeRagStrategy(strategy: "vector" | "index_tree") {
    if (!project || strategySaving || project.rag_strategy === strategy) return;
    setStrategySaving(true);
    setError("");
    try {
      const { updateProject: updated } = await backendGraphqlRequest<{
        updateProject: Project;
      }>(
        getToken,
        `
        mutation UpdateProject($projectId: ID!, $ragStrategy: String) {
          updateProject(projectId: $projectId, ragStrategy: $ragStrategy) { id name description rag_strategy created_at updated_at }
        }
      `,
        { projectId, ragStrategy: strategy },
      );
      invalidateGraphqlCache([
        "projects",
        `project:${projectId}`,
        `documents:${projectId}`,
        `workspace:${projectId}`,
      ]);
      if (strategy === "index_tree" && documents.length) {
        try {
          const { projectIndexTreeStatus: currentTreeStatus } =
            await backendGraphqlRequest<{
              projectIndexTreeStatus: ProjectIndexTreeStatus | null;
            }>(
              getToken,
              `
            query ProjectIndexTreeStatus($projectId: ID!) {
              projectIndexTreeStatus(projectId: $projectId) { status progress error_message updated_at }
            }
          `,
              { projectId },
            );
          setTreeStatus(currentTreeStatus);
        } catch {
          setTreeStatus(null);
        }
      }
      setProject(updated);
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the RAG strategy.",
      );
    } finally {
      setStrategySaving(false);
    }
  }

  async function retryTreeIndexing() {
    if (treeRetrying) return;
    setTreeRetrying(true);
    setError("");
    try {
      await backendGraphqlRequest<{ reindexProjectTree: boolean }>(
        getToken,
        `
        mutation ReindexProjectTree($projectId: ID!) { reindexProjectTree(projectId: $projectId) }
      `,
        { projectId },
      );
      setTreeStatus({
        status: "pending",
        progress: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not retry project indexing.",
      );
    } finally {
      setTreeRetrying(false);
    }
  }

  async function createConversation() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { createConversation: conversation } = await backendGraphqlRequest<{
        createConversation: Conversation;
      }>(
        getToken,
        `
        mutation CreateConversation($projectId: ID!) {
          createConversation(projectId: $projectId) { id title updated_at }
        }
      `,
        { projectId },
      );
      setConversations((current) =>
        [conversation, ...current.filter((item) => item.id !== conversation.id)]
          .slice(0, CONVERSATION_PAGE_SIZE),
      );
      setConversationOffset(CONVERSATION_PAGE_SIZE);
      setHasMoreConversations(hasMoreConversations || conversations.length >= CONVERSATION_PAGE_SIZE);
      invalidateGraphqlCache([
        `conversations:${projectId}`,
        `workspace:${projectId}`,
      ]);
      navigateToConversation(conversation.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start a conversation.",
      );
    } finally {
      setBusy(false);
    }
  }

  function openRename(conversation: Conversation) {
    setRenameTarget(conversation);
    setRenameTitle(conversation.title);
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget || !renameTitle.trim() || busy) return;
    setBusy(true);
    try {
      const { updateConversation: updated } = await backendGraphqlRequest<{
        updateConversation: Conversation;
      }>(
        getToken,
        `
        mutation UpdateConversation($projectId: ID!, $conversationId: ID!, $title: String!) {
          updateConversation(projectId: $projectId, conversationId: $conversationId, title: $title) { id title updated_at }
        }
      `,
        {
          projectId,
          conversationId: renameTarget.id,
          title: renameTitle.trim(),
        },
      );
      setConversations((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      invalidateGraphqlCache([
        `conversations:${projectId}`,
        `workspace:${projectId}`,
      ]);
      setRenameTarget(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not rename this conversation.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setError("");
    const target = deleteTarget;
    try {
      if (target.kind === "document") {
        await backendGraphqlRequest<{ deleteDocument: boolean }>(
          getToken,
          `
          mutation DeleteDocument($projectId: ID!, $documentId: ID!) {
            deleteDocument(projectId: $projectId, documentId: $documentId)
          }
        `,
          { projectId, documentId: target.id },
        );
        invalidateGraphqlCache([
          "projects",
          `documents:${projectId}`,
          `workspace:${projectId}`,
        ]);
        deletedDocumentIdsRef.current = new Set([...deletedDocumentIdsRef.current, target.id]);
        setDeletedDocuments({ projectId, ids: deletedDocumentIdsRef.current });
        setDocuments((current) =>
          current.filter((item) => item.id !== target.id),
        );
        setRevision((current) => current + 1);
      } else {
        await backendGraphqlRequest<{ deleteConversation: boolean }>(
          getToken,
          `
          mutation DeleteConversation($projectId: ID!, $conversationId: ID!) {
            deleteConversation(projectId: $projectId, conversationId: $conversationId)
          }
        `,
          { projectId, conversationId: target.id },
        );
        const remaining = conversations.filter((item) => item.id !== target.id);
        setConversations(remaining);
        setConversationOffset((current) => Math.max(0, current - 1));
        setRoutedConversation((current) =>
          current?.conversation.id === target.id ? null : current,
        );
        if (routeConversationId === target.id) {
          setResolvedRouteKey(`${projectId}:${target.id}`);
        }
        invalidateGraphqlCache([
          `conversations:${projectId}`,
          `messages:${projectId}:${target.id}`,
          `workspace:${projectId}`,
        ]);
      }
      setDeleteTarget(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not delete ${target.kind}.`,
      );
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  const treeIndexPending =
    documents.length > 0 &&
    (!treeStatus ||
      treeStatus.status === "pending" ||
      treeStatus.status === "processing");
  const indexing = treeIndexPending || hasPendingDocuments;
  const hasSearchableDocuments =
    project?.rag_strategy === "index_tree"
      ? treeStatus?.status === "completed"
      : documents.some((item) => item.processing_status === "completed");
  const sendDisabledReason = !documents.length
    ? "Upload a PDF to ask a question."
    : project?.rag_strategy === "index_tree" && treeStatus?.status === "failed"
      ? "Retry project index creation before asking a question."
      : !hasSearchableDocuments && !indexing
        ? "Upload and finish indexing a PDF to ask a question."
        : undefined;

  if (loadedProjectId !== projectId) {
    return (
      <Box sx={{ minHeight: "75dvh", display: "grid", placeItems: "center" }}>
        <CircularProgress aria-label="Loading project" />
      </Box>
    );
  }

  if (!project) {
    return (
      <Container maxWidth="md" sx={{ py: 5 }}>
        <Alert
          severity="error"
          action={
            <Button component={Link} href="/" color="inherit">
              Back to projects
            </Button>
          }
        >
          {error || "This project could not be found."}
        </Alert>
      </Container>
    );
  }

  return (
    <Box component="main" sx={{ minHeight: "100dvh", pb: 4 }}>
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 1100,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Container maxWidth="xl">
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              minHeight: 64,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Tooltip title="Back to projects">
              <IconButton
                component={Link}
                href="/"
                aria-label="Back to projects"
                size="small"
              >
                <ArrowBackRounded />
              </IconButton>
            </Tooltip>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                Magnify / Projects
              </Typography>
              <Typography variant="h3" noWrap>
                {project.name}
              </Typography>
            </Box>
            <UserButton />
          </Stack>
        </Container>
      </Box>

      <Container maxWidth="xl" sx={{ pt: 3 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
            {error}
          </Alert>
        )}
        {project.description && (
          <Typography color="text.secondary" variant="body2" sx={{ mb: 2.5 }}>
            {project.description}
          </Typography>
        )}

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "300px minmax(0, 1fr)" },
            gap: 2,
            alignItems: "start",
          }}
        >
          <Stack spacing={2}>
            <Paper
              variant="outlined"
              sx={{
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                maxHeight: { xs: "38dvh", md: "min(46dvh, 420px)" },
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  px: 1.75,
                  py: 1.5,
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: 1,
                  borderColor: "divider",
                }}
              >
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center" }}
                >
                  <ForumOutlined color="primary" fontSize="small" />
                  <Typography variant="h3">Conversations</Typography>
                </Stack>
                <Tooltip title="New conversation">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="New conversation"
                      onClick={() => void createConversation()}
                      disabled={busy}
                    >
                      <AddRounded />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              {conversations.length ? (
                <List
                  disablePadding
                  sx={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}
                >
                  {conversations.map((conversation) => (
                    <Stack
                      key={conversation.id}
                      direction="row"
                      sx={{
                        alignItems: "center",
                        px: 0.75,
                        borderBottom: 1,
                        borderColor: "divider",
                        "&:last-child": { borderBottom: 0 },
                      }}
                    >
                      <ListItemButton
                        selected={conversation.id === conversationId}
                        onClick={() => navigateToConversation(conversation.id)}
                        sx={{ minWidth: 0, py: 1 }}
                      >
                        <ListItemText
                          primary={conversation.title}
                          secondary={new Date(
                            conversation.updated_at,
                          ).toLocaleDateString()}
                          slotProps={{
                            primary: { variant: "body2", noWrap: true },
                            secondary: { variant: "caption" },
                          }}
                        />
                      </ListItemButton>
                      <Tooltip title="Rename conversation">
                        <IconButton
                          size="small"
                          aria-label={`Rename ${conversation.title}`}
                          onClick={() => openRename(conversation)}
                        >
                          <Typography
                            variant="caption"
                            sx={{ fontWeight: 800 }}
                          >
                            Aa
                          </Typography>
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete conversation">
                        <IconButton
                          size="small"
                          color="error"
                          aria-label={`Delete ${conversation.title}`}
                          onClick={() =>
                            setDeleteTarget({
                              kind: "conversation",
                              id: conversation.id,
                              label: conversation.title,
                            })
                          }
                        >
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  ))}
                  {hasMoreConversations && (
                    <ListItem disableGutters sx={{ px: 1, py: 0.75 }}>
                      <Button
                        fullWidth
                        size="small"
                        onClick={() => void loadPreviousConversations()}
                        disabled={busy || loadingMoreConversations}
                        startIcon={
                          loadingMoreConversations
                            ? <CircularProgress size={14} color="inherit" />
                            : undefined
                        }
                      >
                        {loadingMoreConversations ? "Loading conversations…" : "Load previous 20"}
                      </Button>
                    </ListItem>
                  )}
                </List>
              ) : (
                <Box sx={{ p: 2 }}>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 1.25 }}
                  >
                    No conversations yet.
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<AddRounded />}
                    onClick={() => void createConversation()}
                    disabled={busy}
                  >
                    Start a conversation
                  </Button>
                </Box>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
              <Box
                sx={{
                  px: 1.75,
                  py: 1.5,
                  borderBottom: 1,
                  borderColor: "divider",
                }}
              >
                <Typography variant="h3">Documents</Typography>
                <Typography variant="caption" color="text.secondary">
                  {documents.length} {documents.length === 1 ? "PDF" : "PDFs"}{" "}
                  in this project
                </Typography>
              </Box>
              <Box sx={{ p: 1.5 }}>
                <FileUpload
                  key={projectId}
                  projectId={projectId}
                  indexing={indexing}
                  deletedDocumentIds={deletedDocuments?.projectId === projectId ? deletedDocuments.ids : undefined}
                  getToken={getToken}
                  onUploaded={() => {
                    invalidateGraphqlCache([
                      "projects",
                      `documents:${projectId}`,
                      `workspace:${projectId}`,
                    ]);
                    setRevision((current) => current + 1);
                  }}
                />
                {documents.length > 0 && (
                  <List disablePadding sx={{ mt: 1.25 }}>
                    {documents.map((document) => (
                      <Stack
                        key={document.id}
                        direction="row"
                        spacing={0.75}
                        sx={{
                          py: 1,
                          alignItems: "center",
                          borderTop: 1,
                          borderColor: "divider",
                        }}
                      >
                        <InsertDriveFileOutlined
                          fontSize="small"
                          color="action"
                        />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography
                            variant="body2"
                            title={document.file_name}
                            noWrap
                          >
                            {document.file_name}
                          </Typography>
                          <Stack
                            direction="row"
                            spacing={0.75}
                            sx={{
                              mt: 0.4,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <Chip
                              size="small"
                              label={document.processing_status}
                              color={
                                document.processing_status === "completed"
                                  ? "success"
                                  : document.processing_status === "failed"
                                    ? "error"
                                    : "default"
                              }
                            />
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              {(document.file_size / 1024 / 1024).toFixed(1)} MB
                            </Typography>
                          </Stack>
                          {document.processing_error && (
                            <Typography
                              variant="caption"
                              color="error.main"
                              sx={{
                                display: "block",
                                overflowWrap: "anywhere",
                              }}
                            >
                              {document.processing_error}
                            </Typography>
                          )}
                        </Box>
                        <Tooltip title="Delete PDF">
                          <IconButton
                            size="small"
                            color="error"
                            aria-label={`Delete ${document.file_name}`}
                            onClick={() =>
                              setDeleteTarget({
                                kind: "document",
                                id: document.id,
                                label: document.file_name,
                              })
                            }
                          >
                            <DeleteOutlineRounded fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    ))}
                  </List>
                )}
                {documents.length === 0 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 1 }}
                  >
                    No PDFs uploaded yet.
                  </Typography>
                )}
              </Box>
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.75 }}>
              <FormControl disabled={strategySaving} fullWidth>
                <FormLabel
                  id="rag-strategy-label"
                  sx={{
                    color: "text.primary",
                    fontWeight: 700,
                    typography: "subtitle2",
                  }}
                >
                  RAG Strategy
                </FormLabel>
                <RadioGroup
                  aria-labelledby="rag-strategy-label"
                  name="rag-strategy"
                  value={project.rag_strategy}
                  onChange={(event) =>
                    void changeRagStrategy(
                      event.target.value as "vector" | "index_tree",
                    )
                  }
                  sx={{ mt: 0.5, gap: 0.5 }}
                >
                  <FormControlLabel
                    value="vector"
                    control={<Radio size="small" />}
                    sx={{ alignItems: "flex-start", mx: 0 }}
                    label={
                      <Box sx={{ pt: 0.35 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>
                          Vector RAG
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Embeddings and vector similarity retrieve relevant
                          chunks.
                        </Typography>
                      </Box>
                    }
                  />
                  <FormControlLabel
                    value="index_tree"
                    control={<Radio size="small" />}
                    sx={{ alignItems: "flex-start", mx: 0 }}
                    label={
                      <Box sx={{ pt: 0.35 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>
                          Vectorless Index-Tree RAG
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          An LLM navigates a project-wide index without vector
                          search.
                        </Typography>
                      </Box>
                    }
                  />
                </RadioGroup>
              </FormControl>
              {documentProcessingStatus && (
                <Stack spacing={0.75} sx={{ mt: 1 }}>
                  <Chip
                    size="small"
                    label={documentProcessingStatus}
                    color={
                      documentProcessingStatus === "completed"
                        ? "success"
                        : documentProcessingStatus === "failed"
                          ? "error"
                          : "default"
                    }
                    sx={{ alignSelf: "flex-start" }}
                  />
                  {project.rag_strategy === "index_tree" && (
                    <>
                      {treeStatus?.error_message && (
                        <Typography
                          variant="caption"
                          color="error.main"
                          sx={{ overflowWrap: "anywhere" }}
                        >
                          {treeStatus.error_message}
                        </Typography>
                      )}
                      {(treeStatus?.status === "pending" ||
                        treeStatus?.status === "processing") &&
                        treeStatus.progress !== null &&
                        treeStatus.progress !== undefined && (
                          <Typography variant="caption" color="text.secondary">
                            Indexing project PDFs: {treeStatus.progress}%
                          </Typography>
                        )}
                      {treeStatus?.status === "failed" && (
                        <Button
                          size="small"
                          onClick={() => void retryTreeIndexing()}
                          disabled={treeRetrying}
                          startIcon={
                            treeRetrying ? (
                              <CircularProgress size={14} />
                            ) : (
                              <AddRounded />
                            )
                          }
                        >
                          Retry index
                        </Button>
                      )}
                    </>
                  )}
                </Stack>
              )}
            </Paper>
          </Stack>

          {conversationId ? (
            <Chat
              key={`${projectId}:${conversationId}`}
              projectId={projectId}
              userId={userId ?? "signed-out"}
              conversationId={conversationId}
              getToken={getToken}
              indexing={indexing}
              sendDisabledReason={sendDisabledReason}
              onMessagesChanged={() => setRevision((current) => current + 1)}
            />
          ) : (
            <Paper
              variant="outlined"
              sx={{
                minHeight: 440,
                display: "grid",
                placeItems: "center",
                p: 3,
                textAlign: "center",
              }}
            >
              <Box>
                <ForumOutlined color="primary" sx={{ fontSize: 34, mb: 1 }} />
                <Typography variant="h2">Choose a conversation</Typography>
                <Typography color="text.secondary" sx={{ mt: 0.75, mb: 1.5 }}>
                  Create a conversation to ask questions about this
                  project&apos;s PDFs.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddRounded />}
                  onClick={() => void createConversation()}
                  disabled={busy}
                >
                  New conversation
                </Button>
              </Box>
            </Paper>
          )}
        </Box>
      </Container>

      <Dialog
        open={renameTarget !== null}
        onClose={() => !busy && setRenameTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <Box component="form" onSubmit={(event) => void saveRename(event)}>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogContent sx={{ pt: "8px !important" }}>
            <TextField
              autoFocus
              required
              fullWidth
              label="Conversation title"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 160 } }}
            />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2.5 }}>
            <Button onClick={() => setRenameTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={!renameTitle.trim() || busy}
            >
              {busy ? <CircularProgress size={18} color="inherit" /> : "Save"}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => !busy && setDeleteTarget(null)}
      >
        <DialogTitle>Delete {deleteTarget?.kind}?</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            This permanently removes {deleteTarget?.label} from this project.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void confirmDelete()}
            disabled={busy}
          >
            {busy ? <CircularProgress size={18} color="inherit" /> : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
