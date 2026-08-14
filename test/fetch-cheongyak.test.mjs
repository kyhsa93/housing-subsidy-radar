import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(import.meta.dirname, "../scripts/fetch-cheongyak.mjs");

function startStub(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const operation = url.pathname.split("/").pop();
    const page = Number(url.searchParams.get("page"));
    calls.push({ operation, page, serviceKey: url.searchParams.get("serviceKey") });
    const body = handler({ operation, page });
    res.writeHead(body.status ?? 200, { "Content-Type": "application/json" });
    res.end(typeof body.json === "string" ? body.json : JSON.stringify(body.json));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const ok = (data, totalCount = data.length) => ({ json: { currentCount: data.length, data, totalCount } });
const empty = () => ok([]);

function daysFromToday(n, { compact = false } = {}) {
  const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + n);
  const iso = today.toISOString().slice(0, 10);
  return compact ? iso.replace(/-/g, "") : iso;
}

async function run(base, { outDir, env = {} } = {}) {
  const dir = outDir ?? (await mkdtemp(path.join(tmpdir(), "cheongyak-")));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      CHEONGYAK_API_KEY: "test-key",
      CHEONGYAK_API_ENDPOINT: base,
      CHEONGYAK_OUT_DIR: dir,
      RETRY_BACKOFF_MS: "1",
      ...env,
    },
  });
  const payload = JSON.parse(await readFile(path.join(dir, "cheongyak.json"), "utf-8"));
  return { payload, stdout, stderr, dir };
}

test("네 오퍼레이션을 모두 수집하고 각자의 접수일 필드를 읽는다", async () => {
  const stub = await startStub(({ operation, page }) => {
    if (page > 1) return empty();
    switch (operation) {
      case "getAPTLttotPblancDetail":
        return ok([
          {
            HOUSE_MANAGE_NO: "2026000001",
            HOUSE_NM: "APT 단지",
            HOUSE_SECD_NM: "APT",
            SUBSCRPT_AREA_CODE_NM: "서울",
            RCEPT_BGNDE: daysFromToday(1),
            RCEPT_ENDDE: daysFromToday(5),
          },
        ]);
      case "getOptLttotPblancDetail":
        return ok([
          {
            HOUSE_MANAGE_NO: "2026000002",
            HOUSE_NM: "임의공급 단지",
            HOUSE_SECD_NM: "임의공급",
            SUBSCRPT_AREA_CODE_NM: "경기",
            SUBSCRPT_RCEPT_BGNDE: daysFromToday(1, { compact: true }),
            SUBSCRPT_RCEPT_ENDDE: daysFromToday(3, { compact: true }),
          },
        ]);
      case "getRemndrLttotPblancDetail":
        return ok([
          {
            HOUSE_MANAGE_NO: "2026000003",
            HOUSE_NM: "무순위 단지",
            HOUSE_SECD_NM: "무순위",
            SUBSCRPT_AREA_CODE_NM: "인천",
            SUBSCRPT_RCEPT_BGNDE: null,
            SUBSCRPT_RCEPT_ENDDE: null,
            GNRL_RCEPT_BGNDE: daysFromToday(1),
            GNRL_RCEPT_ENDDE: daysFromToday(2),
          },
        ]);
      case "getUrbtyOfctlLttotPblancDetail":
        return ok([
          {
            HOUSE_MANAGE_NO: "2026000004",
            HOUSE_NM: "오피스텔 단지",
            HOUSE_SECD_NM: "도시형/오피스텔/생활숙박시설/민간임대",
            HOUSE_DTL_SECD_NM: "오피스텔",
            SUBSCRPT_AREA_CODE_NM: "부산",
            SUBSCRPT_RCEPT_BGNDE: daysFromToday(1),
            SUBSCRPT_RCEPT_ENDDE: daysFromToday(4),
          },
        ]);
      default:
        return empty();
    }
  });

  try {
    const { payload } = await run(stub.base);
    assert.equal(payload.notices.length, 4);
    assert.deepEqual(payload.staleSources, []);

    const byType = Object.fromEntries(payload.notices.map((n) => [n.type, n]));
    assert.equal(byType.apt.receiptEnd, daysFromToday(5));
    assert.equal(byType.arbitrary.receiptEnd, daysFromToday(3));
    assert.equal(byType.remndr.receiptEnd, daysFromToday(2));
    assert.equal(byType.remndr.receiptStart, daysFromToday(1));
    assert.equal(byType.urbty.kind, "오피스텔");

    assert.deepEqual(
      payload.notices.map((n) => n.type),
      ["remndr", "arbitrary", "urbty", "apt"]
    );
    assert.deepEqual(payload.areas, ["경기", "부산", "서울", "인천"]);
  } finally {
    await stub.close();
  }
});

test("이미 마감된 공고와 마감일 없는 공고는 빼고 저장한다", async () => {
  const stub = await startStub(({ operation, page }) => {
    if (page > 1 || operation !== "getAPTLttotPblancDetail") return empty();
    return ok([
      {
        HOUSE_MANAGE_NO: "1",
        HOUSE_NM: "어제 마감",
        HOUSE_SECD_NM: "APT",
        RCEPT_ENDDE: daysFromToday(-1),
      },
      {
        HOUSE_MANAGE_NO: "2",
        HOUSE_NM: "오늘 마감",
        HOUSE_SECD_NM: "APT",
        RCEPT_ENDDE: daysFromToday(0),
      },
      {
        HOUSE_MANAGE_NO: "3",
        HOUSE_NM: "마감일 없음",
        HOUSE_SECD_NM: "APT",
        RCEPT_ENDDE: null,
      },
      {
        HOUSE_MANAGE_NO: "4",
        HOUSE_NM: "잘못된 날짜",
        HOUSE_SECD_NM: "APT",
        RCEPT_ENDDE: "20260231",
      },
    ]);
  });

  try {
    const { payload } = await run(stub.base);
    assert.deepEqual(
      payload.notices.map((n) => n.name),
      ["오늘 마감"]
    );
  } finally {
    await stub.close();
  }
});

test("한 종류만 실패하면 그 종류의 직전 데이터를 살려둔다", async () => {
  const stub = await startStub(({ operation, page }) => {
    if (operation === "getRemndrLttotPblancDetail") return { status: 500, json: "not json" };
    if (page > 1 || operation !== "getAPTLttotPblancDetail") return empty();
    return ok([
      {
        HOUSE_MANAGE_NO: "1",
        HOUSE_NM: "새 APT",
        HOUSE_SECD_NM: "APT",
        RCEPT_ENDDE: daysFromToday(3),
      },
    ]);
  });

  const dir = await mkdtemp(path.join(tmpdir(), "cheongyak-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "cheongyak.json"),
    JSON.stringify({
      notices: [
        { id: "remndr:9", type: "remndr", name: "지난 무순위", kind: "무순위", receiptEnd: daysFromToday(7) },
        { id: "apt:9", type: "apt", name: "지난 APT", kind: "APT", receiptEnd: daysFromToday(7) },
      ],
    })
  );

  try {
    const { payload } = await run(stub.base, { outDir: dir });
    assert.deepEqual(payload.staleSources, ["무순위·잔여세대"]);
    const names = payload.notices.map((n) => n.name);
    assert.ok(names.includes("지난 무순위"));
    assert.ok(names.includes("새 APT"));
    assert.ok(!names.includes("지난 APT"));
  } finally {
    await stub.close();
  }
});

test("모든 종류가 실패하면 기존 파일을 덮어쓰지 않고 종료한다", async () => {
  const stub = await startStub(() => ({ status: 500, json: "not json" }));
  const dir = await mkdtemp(path.join(tmpdir(), "cheongyak-"));
  const before = JSON.stringify({ notices: [{ id: "apt:1", type: "apt", name: "지키고 싶은 데이터" }] });
  await writeFile(path.join(dir, "cheongyak.json"), before);

  try {
    await assert.rejects(() => run(stub.base, { outDir: dir }));
    assert.equal(await readFile(path.join(dir, "cheongyak.json"), "utf-8"), before);
  } finally {
    await stub.close();
  }
});

test("인증 오류는 재시도하지 않고 바로 멈춘다", async () => {
  const stub = await startStub(() => ({ json: { code: -4, msg: "인증키가 유효하지 않습니다" } }));
  try {
    await assert.rejects(() => run(stub.base));
    assert.equal(stub.calls.length, 1);
  } finally {
    await stub.close();
  }
});

test("서비스키를 다시 인코딩하지 않고 그대로 보낸다", async () => {
  const stub = await startStub(() => empty());
  try {
    await run(stub.base, { env: { CHEONGYAK_API_KEY: "abc+def%2Fghi==" } });
    assert.equal(stub.calls[0].serviceKey, "abc def/ghi==");
  } finally {
    await stub.close();
  }
});

test("한 페이지에 다 못 담으면 totalCount만큼 이어서 받는다", async () => {
  const rows = (start, count) =>
    Array.from({ length: count }, (_, i) => ({
      HOUSE_MANAGE_NO: String(start + i),
      HOUSE_NM: `단지 ${start + i}`,
      HOUSE_SECD_NM: "APT",
      RCEPT_ENDDE: daysFromToday(3),
    }));

  const stub = await startStub(({ operation, page }) => {
    if (operation !== "getAPTLttotPblancDetail") return empty();
    if (page === 1) return ok(rows(1, 500), 600);
    if (page === 2) return ok(rows(501, 100), 600);
    return { json: { data: [], totalCount: 600 } };
  });

  try {
    const { payload } = await run(stub.base);
    assert.equal(payload.notices.length, 600);
    const aptCalls = stub.calls.filter((c) => c.operation === "getAPTLttotPblancDetail");
    assert.deepEqual(
      aptCalls.map((c) => c.page),
      [1, 2]
    );
  } finally {
    await stub.close();
  }
});
