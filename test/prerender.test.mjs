// 프리렌더는 화면에 안 보이는 작업이라(클라이언트가 어차피 다시 그린다) 눈으로는
// 깨진 걸 못 잡는다. 크롤러가 받는 HTML이 실제로 채워져 있는지는 테스트로만 지킨다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyPrerender, escapeHtml, noticesHtml } from "../scripts/prerender.mjs";

const root = path.resolve(import.meta.dirname, "..");
const readIndex = () => readFile(path.join(root, "docs/index.html"), "utf8");
const readNotices = () => readFile(path.join(root, "docs/data/cheongyak.json"), "utf8").then(JSON.parse);

const wrap = (inner) => `<div><!--prerender:notices-->${inner}<!--/prerender:notices--></div>`;

test("자리표시 주석 사이를 갈아끼우고, 다시 돌려도 결과가 같다", () => {
  const once = applyPrerender(wrap("불러오는 중..."), { notices: "<article>공고</article>" });
  assert.equal(once, wrap("<article>공고</article>"));
  assert.equal(applyPrerender(once, { notices: "<article>공고</article>" }), once);
});

test("데이터가 없으면 기존 안내 문구를 그대로 둔다", () => {
  const html = wrap("불러오는 중...");
  assert.equal(applyPrerender(html, { notices: null }), html);
  assert.equal(noticesHtml(null), null);
  assert.equal(noticesHtml({ notices: [] }), null);
});

test("자리표시 주석이 사라졌으면 조용히 넘어가지 않는다", () => {
  assert.throws(() => applyPrerender("<div>표시 없음</div>", { notices: "<article>공고</article>" }), /자리표시/);
});

test("단지 이름의 따옴표·꺾쇠는 마크업으로 새지 않는다", () => {
  const html = noticesHtml({ notices: [{ name: '<script>alert("x")</script> & 단지', area: "서울" }] });
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(escapeHtml('a"b'), "a&quot;b");
});

// 만든 시점의 "오늘"이 섞이면 데이터가 그대로여도 하루 뒤엔 결과가 달라져서,
// 커밋된 HTML이 데이터와 맞는지 검사할 수 없게 된다.
test("정적 HTML에 D-day처럼 만든 날짜에 좌우되는 값을 넣지 않는다", async () => {
  const html = noticesHtml(await readNotices());
  assert.ok(!/D-\d|마감 임박|오늘 마감/.test(html), "만든 날짜에 좌우되는 값이 실렸다");
});

test("커밋된 HTML이 지금 데이터로 다시 그린 결과와 같다", async () => {
  const [html, payload] = await Promise.all([readIndex(), readNotices()]);
  assert.equal(
    html,
    applyPrerender(html, { notices: noticesHtml(payload) }),
    "docs/index.html이 데이터와 어긋납니다. node scripts/prerender.mjs를 실행하세요."
  );
});

test("크롤러가 받는 HTML에 오늘 공고 이름이 실제로 들어 있다", async () => {
  const [html, payload] = await Promise.all([readIndex(), readNotices()]);
  assert.ok(html.includes(escapeHtml(payload.notices[0].name)), "첫 공고 이름이 정적 HTML에 없다");
});

// 지원금 패널은 처음에 hidden이다. 거기까지 심으면 화면에 없는 걸 크롤러에만 보여주는 꼴이 된다.
test("처음에 감춰진 지원금 패널은 심지 않는다", async () => {
  const html = await readIndex();
  assert.ok(!html.includes("<!--prerender:subsidy-->"), "감춰진 패널에 자리표시 주석이 생겼다");
  assert.ok(html.includes('<div id="subsidy-list"></div>'), "지원금 목록이 비어 있지 않다");
});

test("GA 로더와 사이트 구분이 붙어 있다", async () => {
  const html = await readIndex();
  assert.ok(html.includes('<script src="./analytics.js"></script>'), "GA 로더가 없다");
  assert.ok(html.includes('<meta name="site-group" content="housing-subsidy-radar">'), "사이트 구분이 없다");
  // 콘텐츠가 얇은 상태라 광고는 붙이지 않는다(도메인 전체 심사에 영향을 준다).
  assert.ok(!html.includes("adsbygoogle"), "애드센스가 붙었다");
});

// 실패했을 때 사용자가 할 수 있는 게 새로고침뿐이면, 그 안내라도 화면에 있어야 한다.
test("로드가 실패하면 다시 시도할 수단을 준다", async () => {
  const html = await readIndex();
  for (const id of ["load-retry", "subsidy-retry"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} 버튼이 없다`);
  }
  assert.ok(html.includes('event("load_retry"'), "재시도를 계측하지 않는다");
});
