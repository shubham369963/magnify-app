import { notFound } from "next/navigation";
import ProjectDetail from "../components/project-detail";

export default async function ProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const { projectId } = await searchParams;
  if (typeof projectId !== "string" || !projectId) notFound();

  return <ProjectDetail key={projectId} projectId={projectId} />;
}