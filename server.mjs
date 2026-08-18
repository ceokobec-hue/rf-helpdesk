#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// RF Helpdesk — 사내 서버
//   node server.mjs            (기본 7801 포트)
//   PORT=8080 node server.mjs
//
// 외부 의존성 없이 Node 기본 모듈만 쓴다. 사내 서버에 올릴 때
// 빌드나 추가 설치가 필요 없어야 몇 년 뒤에도 그대로 뜬다.
// ─────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSubstitutes } from './tools/lib/substitute.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7801);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── 데이터 적재 (기동 시 1회, 메모리 상주) ────────────────────
let DB = { meta: null, models: [], byId: new Map(), report: null };

async function loadDB() {
  const p = path.join(ROOT, 'data/models.json');
  try {
    const d = JSON.parse(await fs.readFile(p, 'utf8'));
    DB.meta = { generated_at: d.generated_at, source: d.source, summary: d.summary };
    DB.models = d.models;
    DB.byId = new Map(d.models.map(m => [m.id.toUpperCase(), m]));
    try { DB.report = JSON.parse(await fs.readFile(path.join(ROOT, 'data/sync-report.json'), 'utf8')); } catch {}
    console.log(`[데이터] ${d.models.length}개 모델 적재 · 수집시각 ${d.generated_at}`);
  } catch (e) {
    console.error(`[데이터] data/models.json 을 읽지 못했습니다 → 먼저 "npm run sync" 를 실행하세요.\n        ${e.message}`);
  }
}

const V = (m, k) => m.effective?.[k]?.value ?? null;

/** 검색용 슬림 레코드 — 브라우저로 한 번에 보낸다 (전체 250KB 미만) */
const slim = m => ({
  id: m.id, kind: m.kind, type: m.type, series: m.series,
  cooling: m.cooling ?? null,
  cap_min: V(m, 'cap_min'), cap_max: V(m, 'cap_max'),
  v_rf: V(m, 'v_rf_working'), v_pk: V(m, 'v_peak_test'),
  i_max: V(m, 'i_max'), dia: V(m, 'diameter'),
  turns: m.spec?.tuner_turns?.value ?? null,
  disagree: (m.effective?.disagree ?? []).length,
  flags: m.flags ?? [],
  has_pdf: !!m.pdf,
});

// ── 라우팅 ────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

async function serveFile(res, abs) {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fssync.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — 파일을 찾을 수 없습니다');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

  try {
    // ── API ──
    if (p === '/api/index') {
      return json(res, { meta: DB.meta, models: DB.models.map(slim) });
    }
    if (p.startsWith('/api/model/')) {
      const m = DB.byId.get(p.slice('/api/model/'.length).toUpperCase());
      return m ? json(res, m) : json(res, { error: '해당 품번을 찾을 수 없습니다' }, 404);
    }
    if (p.startsWith('/api/substitutes/')) {
      const m = DB.byId.get(p.slice('/api/substitutes/'.length).toUpperCase());
      if (!m) return json(res, { error: '해당 품번을 찾을 수 없습니다' }, 404);
      const cMin = Number(url.searchParams.get('capMin'));
      const cMax = Number(url.searchParams.get('capMax'));
      const requiredCap = Number.isFinite(cMin) && Number.isFinite(cMax) && cMin > 0 && cMax > cMin
        ? { min: cMin, max: cMax } : null;
      const pool = DB.models.filter(x => x.effective);
      return json(res, { source: slim(m), ...findSubstitutes(m, pool, { requiredCap }) });
    }
    if (p === '/api/report') return json(res, DB.report ?? { error: '리포트 없음' });
    if (p === '/api/health') return json(res, { ok: true, models: DB.models.length, generated_at: DB.meta?.generated_at ?? null });

    // ── 데이터시트 원본 ──
    if (p.startsWith('/datasheets/')) {
      const abs = path.join(ROOT, 'datasheets', path.basename(p));
      return serveFile(res, abs);
    }

    // ── 정적 ──
    const rel = p === '/' ? '/parts.html' : p;
    const abs = path.normalize(path.join(ROOT, 'public', rel));
    if (!abs.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end('403'); }
    return serveFile(res, abs);
  } catch (e) {
    console.error(e);
    return json(res, { error: '서버 오류', detail: e.message }, 500);
  }
});

await loadDB();
server.listen(PORT, HOST, () => {
  console.log('━'.repeat(56));
  console.log('  RF Helpdesk 가동');
  console.log(`  주소  http://localhost:${PORT}`);
  console.log(`  사내  http://<이 서버 IP>:${PORT}`);
  console.log('━'.repeat(56));
});
