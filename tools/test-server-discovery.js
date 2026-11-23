/* 서버 후보 탐색 회귀 검사 — node tools/test-server-discovery.js
 *
 * 빌드 단계가 없는 정적 사이트라 환경별 서버 주소를 빌드 때 넣을 수 없습니다.
 * 그래서 config.js 의 CONFIG.ready() 가 런타임에 후보(SERVER_URLS)를 위에서부터
 * 두드려 먼저 "우리 백엔드"로 답하는 곳에 붙습니다(848072d). 그 규칙이 깨지면
 * 로컬에서 띄운 백엔드를 두고 배포 서버로 나가거나, 배포본이 자기 index.html 을
 * 백엔드로 착각합니다. 브라우저 없이 네트워크를 가로채 그 규칙을 확인합니다.
 *
 *   ① 순서     — 같은 원점이 맞으면 즉시 붙고 뒤 후보는 건드리지 않는다 / 1→2→3순위 강등
 *   ② 판정     — "200 이 왔다"가 아니라 meta.periods 가 있어야 백엔드 (정적 호스팅의 HTML 200 거부)
 *   ③ 실패     — 전부 실패하면 삼키지 않고 경고 · 녹화본이 있으면 보관판(c4d7663)
 *   ④ 고정     — ?server=(허용 출처)·저장 주소는 탐색하지 않는다 · 빈 ?server= 는 해제
 *   ⑤ 경계     — 공개 배포본은 localhost 를 두드리지 않는다(c4d7663) · 허용 밖 ?server= 는
 *                고정되지 않고 탐색이 그대로 돈다(caeb113) · 죽은 후보는 제한 시간에 끊는다
 *   ⑥ 부수     — ready() 는 한 번만 돈다 · 중복 후보 제거 · useServer · ngrok 우회 헤더
 *
 * 848072d 커밋 메시지에만 적혀 있던 7개 시나리오(같은 원점 선택·EC2 미접촉 / 1→2순위 /
 * 1·2→3순위 / 200+HTML 거부 / 전부 실패 시 경고 / ?server= 고정 / 고정 해제)를 재현 가능한
 * 검사로 옮기고, 그 뒤에 붙은 규칙(보관판·localhost 건너뛰기·허용 목록)을 더했습니다.
 *
 * 각 경우를 새 vm 컨텍스트에서 돌립니다(config.js 는 로드 시점에 location 을 읽음).
 * 제한 시간 타이머는 실제로 기다리지 않도록 줄여서 돌리고, 요청된 값(ms)만 기록합니다.
 * HW_CONFIG_SRC 환경변수로 다른 config.js 를 넣을 수 있습니다(변형 검사용).
 * 종료 코드 = 실패 수.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONFIG_PATH = process.env.HW_CONFIG_SRC ||
  path.join(__dirname, '..', 'assets', 'js', 'config.js');
const CONFIG_SRC = fs.readFileSync(CONFIG_PATH, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function memStorage(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => Object.assign({}, m)
  };
}

/* 응답 종류 — 원점(origin) 단위로 정합니다 */
const API = { periods: ['am', 'day', 'pm', 'night'] };           // 우리 백엔드의 meta
const R = {
  api:     () => ({ ok: true, status: 200, json: () => Promise.resolve(API) }),
  html200: () => ({ ok: true, status: 200,                                  // 정적 호스팅의 index.html
                    json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
  other:   () => ({ ok: true, status: 200, json: () => Promise.resolve({ hello: 'world' }) }), // 남의 JSON
  notFound: () => ({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  down:    'down',                                                         // 연결 거부
  hang:    'hang'                                                          // 응답 없음(제한 시간에 끊겨야 함)
};

/**
 * pageUrl 로 연 페이지에서 config.js 를 로드한 컨텍스트.
 *   routes     { 'https://x.example': R.api, ... } — 없는 원점은 연결 거부
 *   storage    localStorage 대용
 *   candidates SERVER_URLS 를 이 목록으로 바꿔 끼운다(같은 배열 객체를 제자리 수정 —
 *              ready() 가 호출 시점에 그 배열을 읽는다)
 *   archive    녹화본 manifest(있으면 보관판 경로를 연다)
 */
function load(pageUrl, opts) {
  opts = opts || {};
  const page = new URL(pageUrl);
  const calls = [];            // 실제로 나간 요청 URL(절대 주소)
  const timers = [];           // setTimeout 에 요청된 ms
  const logs = { info: [], warn: [] };
  const inserted = [];         // 보관판 배너 삽입 기록
  const routes = opts.routes || {};

  const doc = {
    body: { firstChild: null, insertBefore: el => inserted.push(el) },
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, set innerHTML(v) { this._html = v; } }),
    addEventListener() {}
  };

  const ctx = {
    URL, URLSearchParams, Promise, AbortController, clearTimeout,
    setTimeout: (fn, ms) => { timers.push(ms); return setTimeout(fn, 5); },
    location: { href: page.href, origin: page.origin, protocol: page.protocol, host: page.host,
                hostname: page.hostname, port: page.port, search: page.search },
    localStorage: opts.storage || memStorage(),
    sessionStorage: memStorage(),
    document: doc,
    console: { info: m => logs.info.push(String(m)), log() {},
               warn: m => logs.warn.push(String(m)), error() {} },
    fetch: (url, init) => {
      const abs = new URL(String(url), page.href);
      calls.push(abs.href);
      if (/\/archive\/manifest\.json$/.test(abs.pathname)) {
        return Promise.resolve(opts.archive
          ? { ok: true, status: 200, json: () => Promise.resolve(opts.archive) }
          : { ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      const r = routes[abs.origin];
      if (!r || r === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      if (r === 'hang') {
        return new Promise((_, reject) => {
          const sig = init && init.signal;
          if (sig) sig.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      }
      return Promise.resolve(r());
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CONFIG_SRC, ctx);
  const C = ctx.HW.CONFIG;
  if (opts.candidates) {
    C.SERVER_URLS.length = 0;
    opts.candidates.forEach(u => C.SERVER_URLS.push(u));
  }
  return { C, calls, timers, logs, inserted, ctx };
}

/* 이 주소(origin)로 나간 요청 수 */
function hits(calls, origin) { return calls.filter(u => u.indexOf(origin) === 0).length; }

/* ready() 가 끝나지 않으면(제한 시간 처리가 깨진 경우) 테스트가 결과 없이 0 으로 끝나지
   않도록 바깥에서 상한을 둡니다. 시간 초과는 '__TIMEOUT__' 으로 돌아와 해당 검사가 실패합니다. */
function settle(p) {
  return Promise.race([p, new Promise(r => setTimeout(() => r('__TIMEOUT__'), 2000))]);
}
function ready(C) { return settle(C.ready()); }

const PAGES = 'https://hw-dashboard.pages.dev';     // 공개 정적 배포본(포트 없음)
const EC2 = 'https://api.hw.example';               // 배포 서버 역할(848072d 당시의 EC2 자리)
const LOCAL_BE = 'http://localhost:8000';           // 로컬 백엔드
const LOCAL_FE = 'http://localhost:5500';           // 프론트 개발 서버
const EVIL = 'https://evil.example';
const THREE = ['', EC2, LOCAL_BE];                  // 848072d 의 후보 구성

async function main() {
  console.log('① 순서 — 위에서부터, 먼저 맞는 곳에서 멈춘다');
  {
    // 백엔드가 프론트를 /app/ 으로 서빙(:8000) → 같은 원점이 곧 백엔드
    const { C, calls } = load(LOCAL_BE + '/app/index.html',
      { candidates: THREE, routes: { [LOCAL_BE]: R.api, [EC2]: R.api } });
    const base = await ready(C);
    ok('같은 원점이 백엔드면 같은 원점("")에 붙는다', base === '' && C.BASE_URL === '', base);
    ok('같은 원점이 맞으면 배포 서버(EC2)는 두드리지 않는다', hits(calls, EC2) === 0, calls);
    ok('요청은 meta 한 번뿐', calls.length === 1 && /\/api\/v1\/meta$/.test(calls[0]), calls);
  }
  {
    // 공개 배포본: 같은 원점엔 API 가 없다 → 배포 서버로 강등
    const { C, calls } = load(PAGES + '/index.html',
      { candidates: THREE, routes: { [PAGES]: R.notFound, [EC2]: R.api } });
    const base = await ready(C);
    ok('1순위(같은 원점) 실패 → 2순위(배포 서버)에 붙는다', base === EC2, base);
    ok('2순위가 맞으면 3순위는 두드리지 않는다', hits(calls, LOCAL_BE) === 0, calls);
  }
  {
    // 개발 서버(:5500)에서 연 페이지: '' 는 :8000 으로 바뀐다 → 1·2순위 실패 → 3순위
    const ALT = 'http://127.0.0.1:8001';
    const { C, calls } = load(LOCAL_FE + '/index.html',
      { candidates: ['', EC2, ALT], routes: { [ALT]: R.api } });
    const base = await ready(C);
    ok('1·2순위 실패 → 3순위에 붙는다', base === ALT, base);
    ok('두드린 순서가 목록 순서와 같다(:8000 → 배포 서버 → 3순위)',
      calls.length === 3 && calls[0].indexOf(LOCAL_BE) === 0 && calls[1].indexOf(EC2) === 0 &&
      calls[2].indexOf(ALT) === 0, calls);
  }

  console.log('② 판정 — "200 이 왔다"가 아니라 우리 백엔드의 meta 모양');
  {
    const { C, calls } = load(PAGES + '/index.html',
      { candidates: THREE, routes: { [PAGES]: R.html200, [EC2]: R.api } });
    const base = await ready(C);
    ok('정적 호스팅이 돌려준 HTML 200 은 백엔드로 보지 않는다', base === EC2, base);
    ok('HTML 200 다음 후보로 넘어갔다', hits(calls, PAGES) === 1 && hits(calls, EC2) === 1, calls);
  }
  {
    const { C } = load(PAGES + '/index.html',
      { candidates: THREE, routes: { [PAGES]: R.other, [EC2]: R.api } });
    ok('periods 가 없는 JSON 200 도 백엔드로 보지 않는다', (await ready(C)) === EC2);
  }

  console.log('③ 전부 실패 — 삼키지 않는다');
  {
    const { C, logs, ctx } = load(PAGES + '/index.html', { candidates: THREE });
    const base = await ready(C);
    ok('첫 후보를 그대로 둔다(api.js 가 평소의 연결 오류를 내도록)', base === '' && C.BASE_URL === '', base);
    ok('두드린 후보와 실패 사유를 콘솔 경고로 남긴다',
      logs.warn.some(w => /응답이 없습니다/.test(w) && w.indexOf(EC2) >= 0), logs.warn);
    ok('녹화본이 없으면 보관판으로 바꾸지 않는다', ctx.HW.CONFIG.ARCHIVE === null);
  }
  {
    const manifest = { recordedAt: '2026-10-22T00:00:00' };
    const { C, logs, inserted } = load(PAGES + '/index.html', { candidates: THREE, archive: manifest });
    await ready(C);
    ok('녹화본이 있으면 보관판으로 뜬다(CONFIG.ARCHIVE)', C.ARCHIVE && C.ARCHIVE.recordedAt === manifest.recordedAt);
    ok('보관판 안내 배너를 붙인다', inserted.length === 1);
    ok('보관판 전환을 콘솔에 알린다', logs.info.some(m => /보관판/.test(m)), logs.info);
  }

  console.log('④ 고정 — 사용자가 지정한 주소는 탐색이 뒤집지 않는다');
  {
    const st = memStorage();
    const { C, calls } = load(LOCAL_FE + '/index.html?server=http://127.0.0.1:8000',
      { storage: st, routes: { [LOCAL_BE]: R.api } });
    const base = await ready(C);
    ok('허용 출처의 ?server= 는 고정된다', C.SERVER_PINNED === true && base === 'http://127.0.0.1:8000', base);
    ok('고정이면 후보를 하나도 두드리지 않는다', calls.length === 0, calls);
    ok('고정 주소는 기억된다(다음 방문에도)', st.getItem('hw.serverUrl') === 'http://127.0.0.1:8000');
  }
  {
    const st = memStorage({ 'hw.serverUrl': 'http://127.0.0.1:8000' });
    const { C, calls } = load(LOCAL_FE + '/index.html', { storage: st });
    await ready(C);
    ok('기억된 주소만 있어도 고정이고 탐색하지 않는다', C.SERVER_PINNED === true && calls.length === 0, calls);
  }
  {
    const st = memStorage({ 'hw.serverUrl': 'http://127.0.0.1:8000' });
    const { C, calls } = load(LOCAL_FE + '/index.html?server=', { storage: st, routes: { [LOCAL_BE]: R.api } });
    const base = await ready(C);
    ok('빈 ?server= 는 기억을 지운다', st.getItem('hw.serverUrl') === null, st._dump());
    ok('고정이 풀리면 다시 탐색한다', C.SERVER_PINNED === false && calls.length >= 1 && base === LOCAL_BE,
      { base, calls });
  }

  console.log('⑤ 경계 — 공개 배포본 · 허용 목록 · 제한 시간');
  {
    // main 의 기본 후보: ['', 'http://localhost:8000']
    const { C, calls } = load(PAGES + '/index.html', { routes: { [LOCAL_BE]: R.api } });
    await ready(C);
    ok('공개 배포본은 localhost 후보를 두드리지 않는다(권한 창 방지)',
      calls.every(u => !/^https?:\/\/(localhost|127\.)/.test(u)), calls);
    ok('그래서 공개 배포본에서는 로컬 백엔드에 붙지 않는다', C.BASE_URL !== LOCAL_BE, C.BASE_URL);
  }
  {
    const { C, calls } = load(LOCAL_FE + '/index.html', { routes: { [LOCAL_BE]: R.api } });
    const base = await ready(C);
    ok('로컬에서 연 페이지는 localhost 후보를 두드려 붙는다', base === LOCAL_BE && hits(calls, LOCAL_BE) >= 1,
      { base, calls });
  }
  {
    const st = memStorage();
    const { C, calls } = load(PAGES + '/admin.html?server=' + EVIL,
      { storage: st, candidates: THREE, routes: { [EC2]: R.api, [EVIL]: R.api } });
    const base = await ready(C);
    ok('허용 밖 ?server= 는 고정되지 않는다', C.SERVER_PINNED === false && st.getItem('hw.serverUrl') === null);
    ok('대신 평소처럼 탐색해 후보에 붙는다', base === EC2, base);
    ok('허용 밖 주소로는 요청이 한 번도 나가지 않는다', hits(calls, EVIL) === 0, calls);
  }
  {
    const { C, calls, timers } = load(PAGES + '/index.html',
      { candidates: THREE, routes: { [PAGES]: R.hang, [EC2]: R.api } });
    const base = await ready(C);
    ok('응답 없는 후보는 제한 시간에 끊고 다음 후보로 간다', base === EC2 && hits(calls, EC2) === 1,
      { base, calls });
    ok('제한 시간은 2.5초(PROBE_TIMEOUT_MS)', timers.indexOf(2500) >= 0, timers);
  }

  console.log('⑥ 부수 규칙');
  {
    const { C, calls } = load(PAGES + '/index.html',
      { candidates: THREE, routes: { [PAGES]: R.notFound, [EC2]: R.api } });
    const p1 = C.ready();
    const p2 = C.ready();
    await settle(Promise.all([p1, p2]));
    ok('ready() 를 여러 번 불러도 탐색은 한 번(같은 Promise)', p1 === p2 && calls.length === 2, calls);
  }
  {
    // 개발 서버에서 '' 는 :8000 으로 바뀌어 'http://localhost:8000' 후보와 겹친다
    const { C, calls } = load(LOCAL_FE + '/index.html');
    await ready(C);
    ok('자동값과 겹치는 후보는 한 번만 두드린다', hits(calls, LOCAL_BE) === 1, calls);
  }
  {
    const { C, calls } = load(PAGES + '/index.html', { candidates: THREE, routes: { [EC2]: R.api } });
    const base = await C.useServer(LOCAL_BE);
    const again = await ready(C);
    ok('useServer 는 탐색을 건너뛰고 그 주소로 고정한다',
      base === LOCAL_BE && again === LOCAL_BE && calls.length === 0, calls);
  }
  {
    const NGROK = 'https://abc-123.ngrok-free.app';
    const { C } = load(PAGES + '/index.html', { candidates: ['', NGROK], routes: { [NGROK]: R.api } });
    await ready(C);
    ok('ngrok 후보에 붙으면 경고 페이지 우회 헤더를 단다',
      C.BASE_URL === NGROK && C.EXTRA_HEADERS['ngrok-skip-browser-warning'] === 'true', C.EXTRA_HEADERS);
  }

  console.log('\n최종 ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail;
}

main().catch(e => { console.error(e); process.exitCode = 99; });
