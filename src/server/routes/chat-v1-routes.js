import { readBody } from '../http/request.js';

// Chat v1 routes (ADR 0031). Off unless MEMORY_ENABLED is exactly "true" (503 MEMORY_DISABLED). A thread of another household and a
// missing thread answer the same 404 CHAT_THREAD_NOT_FOUND. The message is never logged or echoed outside the answer. No UIN, policy
// number or sealed value is in any body; facts_used carries ids, registry keys and the opened value of confirmed facts only.
//
//   POST /api/v1/chat/threads                body { household_id, holding_id? }                              -> 201 { thread }
//   POST /api/v1/chat/threads/{id}/turns     body { message, input_kind?, audio_document_id?, procedure? }  -> 200 text/event-stream
//
// The turn is validated and authorised first (errors are ordinary JSON). The stream then carries events meta, delta*, answer, done
// (or one error event). The server layer writes the stream; this handler returns { status: 200, sse } where sse(write) runs the turn.

const THREADS = '/api/v1/chat/threads';
const TURNS = /^\/api\/v1\/chat\/threads\/([^/]+)\/turns$/;

export async function handleChatV1Route({ req, url, principal, services }) {
  if (req.method !== 'POST') return null;
  const turn = TURNS.exec(url.pathname);
  if (url.pathname !== THREADS && !turn) return null;
  const chat = services.chatV1;
  if (url.pathname === THREADS) return { status: 201, body: await chat.createThread({ principal, body: await readBody(req, { limitBytes: 1024 }) }) };
  const run = await chat.startTurn({ principal, threadId: turn[1], body: await readBody(req, { limitBytes: 4096 }) });
  return { status: 200, sse: async write => run.run(write) };
}
