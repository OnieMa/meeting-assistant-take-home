import assert from 'node:assert/strict';
import test from 'node:test';
import { complete } from '../worker/notes.ts';

const env = {
  LLM_BASE_URL: 'https://model.example/v1/',
  LLM_MODEL: 'example-deepseek',
  LLM_API_KEY: 'test-only-placeholder',
};

test('uses the configured model, server-side key and compatible JSON request', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.href, 'https://model.example/v1/chat/completions');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer test-only-placeholder');
    assert.deepEqual(JSON.parse(init.body), {
      messages: [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Say hello.' }],
      max_tokens: 90, temperature: 0.2, response_format: { type: 'json_object' },
      model: 'example-deepseek', stream: false, thinking: { type: 'disabled' },
    });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  });
  assert.equal(await complete(env, 'Return JSON.', 'Say hello.', 90, true), '{"ok":true}');
});

test('rejects an upstream redirect without forwarding the key or falling back', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  });
  await assert.rejects(complete(env, 'System', 'Question', 90), /external_llm_http_302/);
  assert.equal(fetch.mock.callCount(), 1);
});
