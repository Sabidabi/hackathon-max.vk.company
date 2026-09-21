export interface HealthResponse {
  status: string;
  service: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/v1/health/ready");

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<HealthResponse>;
}
