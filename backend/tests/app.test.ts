import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('app bootstrap', () => {
  it('responds to health checks', async () => {
    const app = createApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('returns a unified error body for unknown routes', async () => {
    const app = createApp();

    const response = await request(app).get('/api/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: '接口不存在',
      details: { path: '/api/missing' }
    });
  });
});
