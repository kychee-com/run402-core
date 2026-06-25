import type { CoreProject, RuntimeKernelPorts } from "./ports.js";

export interface CreateCoreProjectInput {
  name?: string | null;
}

export interface InspectCoreProjectInput {
  project_id: string;
}

export class ProjectNotFoundError extends Error {
  readonly code = "project_not_found";
  readonly status = 404;

  constructor(readonly projectId: string) {
    super(`Run402 Core project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export function normalizeProjectName(input: CreateCoreProjectInput): string {
  const name = input.name?.trim();
  if (!name) {
    return "local-project";
  }
  if (name.length > 120) {
    throw new RangeError("Project name must be 120 characters or less.");
  }
  return name;
}

export function validateProjectId(projectId: string): string {
  if (!/^prj_[a-z0-9_]{1,96}$/.test(projectId)) {
    throw new RangeError("Project id must match prj_[a-z0-9_]{1,96}.");
  }
  return projectId;
}

export async function createCoreProject(
  ports: Pick<RuntimeKernelPorts, "projects">,
  input: CreateCoreProjectInput,
): Promise<CoreProject> {
  return ports.projects.create({ name: normalizeProjectName(input) });
}

export async function inspectCoreProject(
  ports: Pick<RuntimeKernelPorts, "projects">,
  input: InspectCoreProjectInput,
): Promise<CoreProject> {
  const project = await ports.projects.inspect(validateProjectId(input.project_id));
  if (!project) {
    throw new ProjectNotFoundError(input.project_id);
  }
  return project;
}

export function projectNotFoundEnvelope(error: ProjectNotFoundError): {
  error: "project_not_found";
  message: string;
  project_id: string;
} {
  return {
    error: error.code,
    message: error.message,
    project_id: error.projectId,
  };
}
