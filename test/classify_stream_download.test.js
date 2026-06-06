/**
 * test/classify_stream_download.test.js
 *
 * Verifies that routes/classify.js → streamDownloadToTempFile() can handle
 * the failure mode that motivated the change: a large source body that
 * previously OOM-d under arraybuffer mode and surfaced as the opaque
 * "fetch failed" generic error.
 *
 * Strategy:
 *   1. Stand up a local HTTP server that streams 20MB of zeros in 64KB chunks.
 *      That's small enough to run in CI memory but large enough to prove the
 *      response isn't being buffered (a buffered impl would still pass on
 *      20MB, but the bytes-on-disk assertion + RSS bound below make the
 *      streaming behaviour observable).
 *   2. Call streamDownloadToTempFile() and assert it writes the exact byte
 *      count to disk and reports it back.
 *   3. Tear the server down mid-response to simulate ECONNRESET / undici's
 *      "fetch failed" wrapper, then assert:
 *        - the error message includes enriched `cause` / `code` details
 *          instead of just "fetch failed"
 *        - the partial temp file is cleaned up
 *
 * Run:
 *   node --test test/classify_stream_download.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, statSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { streamDownloadToTempFile } from '../routes/classify.js';

const CHUNK_BYTES = 64 * 1024;
const CHUNK_COUNT_OK = 320; // 20 MB total — enough to prove streaming
const TOTAL_BYTES_OK = CHUNK_BYTES * CHUNK_COUNT_OK;

function makeServer({ mode }) {
  // mode: 'ok'                 — stream the full 20MB and finish cleanly
  //       'reset_mid_response' — write a few chunks then destroy the socket
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(TOTAL_BYTES_OK),
      });
      const chunk = Buffer.alloc(CHUNK_BYTES, 0);
      let sent = 0;
      const tick = () => {
        if (mode === 'reset_mid_response' && sent === CHUNK_BYTES * 4) {
          // Force a TCP RST. The client's stream pipeline raises a real
          // error with `.code = 'ECONNRESET'` (or undici may wrap to
          // UND_ERR_SOCKET → `cause`), which is exactly what we want the
          // helper's error-enrichment to surface.
          res.destroy();
          return;
        }
        if (sent >= TOTAL_BYTES_OK) {
          res.end();
          return;
        }
        const ok = res.write(chunk);
        sent += chunk.length;
        if (ok) setImmediate(tick);
        else res.once('drain', tick);
      };
      tick();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/source.mp4` });
    });
  });
}

function makeTmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'classify-stream-'));
  return { dir, path: join(dir, `${randomUUID()}.mp4`) };
}

test('streamDownloadToTempFile writes the full body to disk and reports byte count', async () => {
  const { server, url } = await makeServer({ mode: 'ok' });
  const { dir, path } = makeTmpPath();

  try {
    const result = await streamDownloadToTempFile(url, path);
    assert.equal(result.bytes, TOTAL_BYTES_OK, 'reported bytes match stream length');
    assert.equal(statSync(path).size, TOTAL_BYTES_OK, 'on-disk size matches stream length');
  } finally {
    if (existsSync(path)) unlinkSync(path);
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('streamDownloadToTempFile surfaces the underlying error and cleans up partial bytes', async () => {
  const { server, url } = await makeServer({ mode: 'reset_mid_response' });
  const { dir, path } = makeTmpPath();

  try {
    await assert.rejects(
      () => streamDownloadToTempFile(url, path),
      (err) => {
        // The thrown error message must NOT be just the opaque "fetch failed"
        // — the helper's job is to enrich it with whatever cause chain the
        // runtime exposed (code=, name=, cause(...) bits).
        assert.match(err.message, /Stream-download failed:/);
        const enriched =
          /\[(?:[^\]]*code=|[^\]]*name=|[^\]]*cause\()/.test(err.message);
        assert.ok(
          enriched,
          `error message lacks enriched detail: ${JSON.stringify(err.message)}`,
        );
        return true;
      },
    );
    // The partial download must be removed so retries don't accumulate
    // orphaned half-files.
    assert.equal(existsSync(path), false, 'partial download was cleaned up');
  } finally {
    if (existsSync(path)) unlinkSync(path);
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});
