export type TokenGetter = () => Promise<string | null>;

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: unknown }>;
}

export async function backendRequest<T>(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Your sign-in session has expired. Sign in again to continue.");

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`/api/backend/${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "message" in body
      ? (body as { message?: unknown }).message
      : undefined;
    const message = Array.isArray(detail) ? detail.join(" ") : detail;
    throw new Error(typeof message === "string" ? message : `Request failed (${response.status}).`);
  }
  return body as T;
}

export async function backendGraphqlRequest<T>(
  getToken: TokenGetter | null,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken ? await getToken() : null;
  if (getToken && !token) throw new Error("Your sign-in session has expired. Sign in again to continue.");

  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch("/api/backend/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null) as GraphQLResponse<T> | null;
  const errors = body?.errors?.map((error) => error.message).filter((message): message is string => typeof message === "string") ?? [];
  if (!response.ok || errors.length) {
    throw new Error(errors.join(" ") || `Request failed (${response.status}).`);
  }
  if (body?.data == null) throw new Error("The backend returned an empty GraphQL response.");
  return body.data;
}