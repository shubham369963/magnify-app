"use client";

import AddRounded from "@mui/icons-material/AddRounded";
import ArrowOutwardRounded from "@mui/icons-material/ArrowOutwardRounded";
import AutoStoriesRounded from "@mui/icons-material/AutoStoriesRounded";
import DeleteOutlineRounded from "@mui/icons-material/DeleteOutlineRounded";
import EditOutlined from "@mui/icons-material/EditOutlined";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import { UserButton, useAuth } from "@clerk/nextjs";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import ConfirmDeleteDialog from "./shared/confirm-delete-dialog";
import { backendGraphqlRequest } from "../lib/client";
import { cachedBackendGraphqlRequest, getCachedGraphqlResult, invalidateGraphqlCache } from "../lib/cache";
import { usePageRevalidation } from "../lib/use-page-revalidation";
import { PROJECTS_QUERY, PROJECTS_VARIABLES } from "../lib/graphql/queries/projects";
import { CREATE_PROJECT_MUTATION } from "../lib/graphql/mutations/create-project";
import { DELETE_PROJECT_MUTATION } from "../lib/graphql/mutations/delete-project";
import { UPDATE_PROJECT_DETAILS_MUTATION } from "../lib/graphql/mutations/update-project-details";
import type { Project } from "../lib/types";

export default function ProjectsDashboard() {
  const { getToken, userId } = useAuth();
  const pageRevision = usePageRevalidation();
  const cacheScope = userId ?? "signed-out";
  const cachedProjects = getCachedGraphqlResult<{ projects: Project[] }>(cacheScope, PROJECTS_QUERY, PROJECTS_VARIABLES, 15_000);
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects?.projects ?? []);
  const [loading, setLoading] = useState(() => !cachedProjects);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogProject, setDialogProject] = useState<Project | "create" | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    cachedBackendGraphqlRequest<{ projects: Project[] }>(
      getToken,
      PROJECTS_QUERY,
      PROJECTS_VARIABLES,
      cacheScope,
      15_000,
      ["projects"],
    )
      .then(({ projects: rows }) => { if (active) setProjects(rows); })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        setError(cause instanceof DOMException && cause.name === "TimeoutError"
          ? "Loading projects timed out. Check your connection and try again."
          : cause instanceof Error ? cause.message : "Could not load projects.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cacheScope, getToken, loadAttempt, pageRevision, userId]);

  function openCreate() {
    setName("");
    setDescription("");
    setDialogProject("create");
  }

  function openRename(project: Project) {
    setName(project.name);
    setDescription(project.description ?? "");
    setDialogProject(project);
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      if (dialogProject === "create") {
        const { createProject: created } = await backendGraphqlRequest<{ createProject: Project }>(getToken, CREATE_PROJECT_MUTATION, { name, description });
        invalidateGraphqlCache(["projects"]);
        setProjects((rows) => [created, ...rows]);
      } else if (dialogProject) {
        const { updateProject: updated } = await backendGraphqlRequest<{ updateProject: Project }>(getToken, UPDATE_PROJECT_DETAILS_MUTATION, { projectId: dialogProject.id, name, description });
        invalidateGraphqlCache(["projects", `workspace:${dialogProject.id}`]);
        setProjects((rows) => rows.map((project) => project.id === updated.id ? updated : project));
      }
      setDialogProject(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this project.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteProject) return;
    setSaving(true);
    setError("");
    try {
      await backendGraphqlRequest<{ deleteProject: boolean }>(getToken, DELETE_PROJECT_MUTATION, { projectId: deleteProject.id });
      invalidateGraphqlCache(["projects", `project:${deleteProject.id}`, `workspace:${deleteProject.id}`]);
      setProjects((rows) => rows.filter((project) => project.id !== deleteProject.id));
      setDeleteProject(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this project.");
      setDeleteProject(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box component="main" sx={{ minHeight: "100dvh", pb: 8 }}>
      <Box component="header" sx={{ position: "sticky", top: 0, zIndex: 1100, borderBottom: 1, borderColor: "divider", bgcolor: "rgba(255,255,255,0.88)", backdropFilter: "blur(12px)" }}>
        <Container maxWidth="lg">
          <Stack direction="row" sx={{ minHeight: 68, alignItems: "center", justifyContent: "space-between" }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
            <Box sx={{ width: 34, height: 34, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "white", borderRadius: 1.5 }}>
              <AutoStoriesRounded fontSize="small" />
            </Box>
              <Box>
                <Typography sx={{ fontWeight: 800, lineHeight: 1.1 }}>Magnify</Typography>
                <Typography variant="caption" color="text.secondary">PDF workspace</Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={{ xs: 0.25, sm: 1 }} sx={{ alignItems: "center", flexShrink: 0 }}>
              <Button size="small" href="#projects" color="inherit">Workspaces</Button>
              <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}><UserButton /></Box>
            </Stack>
          </Stack>
        </Container>
      </Box>

      <Container maxWidth="lg" sx={{ pt: { xs: 2.5, md: 4 } }}>
        {error && <Alert
          severity="error"
          sx={{ mb: 3 }}
          onClose={() => setError("")}
          action={loadFailed && <Button color="inherit" size="small" onClick={() => {
            invalidateGraphqlCache(["projects"]);
            setLoading(true);
            setLoadFailed(false);
            setError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}>Retry</Button>}
        >{error}</Alert>}
        <Stack id="projects" direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3.5, alignItems: { xs: "stretch", sm: "end" }, justifyContent: "space-between", scrollMarginTop: 24 }}>
          <Box>
            <Typography variant="overline" color="primary.main" sx={{ fontWeight: 800, letterSpacing: 1.1 }}>YOUR RESEARCH</Typography>
            <Typography variant="h1" sx={{ mt: 0.25 }}>Your workspaces</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>Pick up where you left off or start a new document collection.</Typography>
          </Box>
          <Button variant="contained" startIcon={<AddRounded />} onClick={openCreate}>
            New project
          </Button>
        </Stack>

        {loading ? (
          <Box sx={{ minHeight: 280, display: "grid", placeItems: "center" }}><CircularProgress aria-label="Loading projects" /></Box>
        ) : loadFailed ? null : projects.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ py: { xs: 5, md: 7 }, textAlign: "center" }}>
              <FolderOpenOutlined color="primary" sx={{ fontSize: 36, mb: 1 }} />
              <Typography variant="h2">Start a project</Typography>
              <Typography color="text.secondary" sx={{ mt: 1, mb: 2.5 }}>Create a workspace for a research topic, team, or collection of PDFs.</Typography>
              <Button variant="contained" startIcon={<AddRounded />} onClick={openCreate}>Create project</Button>
            </CardContent>
          </Card>
        ) : (
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" }, gap: 2 }}>
            {projects.map((project, index) => (
              <Card key={project.id} className="home-reveal" variant="outlined" sx={{ minWidth: 0, animationDelay: `${Math.min(index * 55, 220)}ms`, transition: "border-color 140ms ease, transform 140ms ease", "&:hover": { borderColor: "primary.main", transform: "translateY(-2px)" } }}>
                <CardContent sx={{ display: "flex", flexDirection: "column", minHeight: 182, p: 2.25 }}>
                  <Stack direction="row" sx={{ mb: 2, justifyContent: "space-between", alignItems: "center" }}>
                    <Box sx={{ width: 38, height: 38, display: "grid", placeItems: "center", bgcolor: "primary.light", color: "primary.dark", borderRadius: 1.5 }}>
                      <FolderOpenOutlined fontSize="small" />
                    </Box>
                    <Stack direction="row" spacing={0.25}>
                      <IconButton aria-label={`Rename ${project.name}`} title="Rename project" size="small" onClick={() => openRename(project)}><EditOutlined fontSize="small" /></IconButton>
                      <IconButton aria-label={`Delete ${project.name}`} title="Delete project" color="error" size="small" onClick={() => setDeleteProject(project)}><DeleteOutlineRounded fontSize="small" /></IconButton>
                    </Stack>
                  </Stack>
                  <Box component={Link} href={`/project?projectId=${encodeURIComponent(project.id)}`} sx={{ color: "inherit", textDecoration: "none", display: "block", flex: 1, "&:hover .project-title": { color: "primary.main" } }}>
                    <Typography className="project-title" variant="h3" noWrap>{project.name}</Typography>
                    <Typography color="text.secondary" variant="body2" sx={{ mt: 0.75, minHeight: 40, overflowWrap: "anywhere" }}>
                      {project.description || "No description"}
                    </Typography>
                    <Stack direction="row" sx={{ mt: 2, alignItems: "center", justifyContent: "space-between" }}>
                      <Typography variant="caption" color="text.secondary">Updated {new Date(project.updated_at).toLocaleDateString()}</Typography>
                      <ArrowOutwardRounded fontSize="small" color="primary" />
                    </Stack>
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Box>
        )}
      </Container>

      <Dialog open={dialogProject !== null} onClose={() => !saving && setDialogProject(null)} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={(event) => void saveProject(event)}>
          <DialogTitle>{dialogProject && dialogProject !== "create" ? "Rename project" : "Create project"}</DialogTitle>
          <DialogContent sx={{ display: "grid", gap: 2, pt: "8px !important" }}>
            <TextField autoFocus required label="Project name" value={name} onChange={(event) => setName(event.target.value)} slotProps={{ htmlInput: { maxLength: 120 } }} />
            <TextField label="Description" value={description} onChange={(event) => setDescription(event.target.value)} slotProps={{ htmlInput: { maxLength: 500 } }} multiline minRows={2} />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2.5 }}>
            <Button onClick={() => setDialogProject(null)} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={!name.trim() || saving}>
              {saving ? <CircularProgress size={18} color="inherit" /> : dialogProject && dialogProject !== "create" ? "Save changes" : "Create project"}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteProject !== null}
        title="Delete project?"
        description={`This permanently removes ${deleteProject?.name}, its PDFs, and its conversations.`}
        confirmLabel="Delete project"
        busy={saving}
        onCancel={() => setDeleteProject(null)}
        onConfirm={() => void confirmDelete()}
      />
    </Box>
  );
}