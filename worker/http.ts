export class ApiError extends Error {
  constructor(readonly status: number, code: string) {
    super(code);
  }
}

export const json = (body: unknown, status = 200, headers?: HeadersInit) => {
  const result = new Headers(headers);
  result.set('Cache-Control', 'private, no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return Response.json(body, { status, headers: result });
};

export async function smallJson<T>(request: Request, limit = 40_000): Promise<T> {
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || length <= 0 || length > limit) throw new ApiError(400, 'invalid_request');
  try {
    const result: T = await request.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new ApiError(400, 'invalid_request');
  }
}
