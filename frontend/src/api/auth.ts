export interface AuthUser {
  id: string;
  max_user_id: number;
  display_name: string;
  username: string | null;
  language_code: string | null;
}

export interface AuthBootstrap {
  max_auth_configured: boolean;
  development_auth: boolean;
  max_launch_url: string | null;
  support_link: string | null;
}

/** A failed auth request with its HTTP status (0 — no answer: network error). */
export class AuthRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/** True when the server rejected the launch itself (401/403) — a retry will not help. */
export function isAuthRejected(error: unknown): boolean {
  return error instanceof AuthRequestError && (error.status === 401 || error.status === 403);
}

async function parseAuthResponse(response: Response): Promise<AuthUser> {
  if (!response.ok) {
    throw new AuthRequestError(`Authentication request returned ${response.status}`, response.status);
  }

  return response.json() as Promise<AuthUser>;
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch("/api/v1/auth/me", { credentials: "include" });

  if (response.status === 401) {
    return null;
  }

  return parseAuthResponse(response);
}

export async function fetchAuthBootstrap(): Promise<AuthBootstrap> {
  const response = await fetch("/api/v1/auth/bootstrap", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Bootstrap request returned ${response.status}`);
  }
  return response.json() as Promise<AuthBootstrap>;
}

export async function loginWithMax(initData: string): Promise<AuthUser> {
  const response = await fetch("/api/v1/auth/max", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: initData }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthRequestError("MAX не подтвердил запуск. Закройте мини-приложение и откройте его снова из бота.", response.status);
  }
  if (response.status === 503) {
    throw new AuthRequestError("Вход через MAX пока не настроен на сервере.", response.status);
  }
  return parseAuthResponse(response);
}

export async function loginForDevelopment(): Promise<AuthUser> {
  const response = await fetch("/api/v1/auth/dev", {
    method: "POST",
    credentials: "include",
  });

  return parseAuthResponse(response);
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Logout returned ${response.status}`);
  }
}
