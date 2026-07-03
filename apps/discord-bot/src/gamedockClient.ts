import type {
  ApiErrorBody,
  GameTemplateDto,
  HealthDto,
  InstanceDto,
  JobDto,
} from '@gamedock/shared';

export class GameDockApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'GameDockApiError';
  }
}

/**
 * Thin REST client for the GameDock API, authenticated as a single
 * admin-level API token (Settings -> API tokens). No CSRF header needed -
 * bearer tokens are exempt (see apps/api/src/plugins/auth.ts).
 */
export class GameDockClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let message = `GameDock API request failed (${response.status})`;
      try {
        const data = (await response.json()) as ApiErrorBody;
        if (data.message) message = data.message;
      } catch {
        // non-JSON error body
      }
      throw new GameDockApiError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  listTemplates(): Promise<GameTemplateDto[]> {
    return this.request('GET', '/api/templates');
  }

  createInstance(params: { name: string; templateId: string }): Promise<InstanceDto> {
    return this.request('POST', '/api/instances', params);
  }

  enqueueInstall(instanceId: string): Promise<{ job: JobDto }> {
    return this.request('POST', `/api/instances/${instanceId}/install`);
  }

  getJob(jobId: string): Promise<JobDto> {
    return this.request('GET', `/api/jobs/${jobId}`);
  }

  listInstances(): Promise<InstanceDto[]> {
    return this.request('GET', '/api/instances');
  }

  getHealth(): Promise<HealthDto> {
    return this.request('GET', '/api/system/health');
  }
}
