// 청약홈 분양정보(APT·임의공급)를 받아 마감이 남은 공고만 docs/data/cheongyak.json에 쓴다.
//
// 이 사이트의 목적이 "언제까지 신청할 수 있는가"라서, 수집 단계에서 이미 끝난
// 공고를 걸러내고 마감일 오름차순으로 정렬해 둔다.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.CHEONGYAK_OUT_DIR
  ? path.resolve(process.env.CHEONGYAK_OUT_DIR)
  : path.resolve(import.meta.dirname, "../docs/data");
const outFile = path.join(dataDir, "cheongyak.json");

const API_KEY = process.env.CHEONGYAK_API_KEY;
// 시크릿에는 https://api.odcloud.kr/api 까지만 들어 있다. 서비스 경로와 오퍼레이션은
// 코드가 붙인다 - 같은 시크릿으로 odcloud의 다른 API도 쓸 수 있고, 오퍼레이션을
// 바꿀 때 시크릿을 건드리지 않아도 된다.
const API_BASE = process.env.CHEONGYAK_API_ENDPOINT;
const SERVICE = "ApplyhomeInfoDetailSvc/v1";

const PER_PAGE = 500;
// totalCount를 그대로 믿고 돌다가 응답이 이상하면 하루치 호출을 다 태울 수 있다.
const MAX_PAGES = 30;

/**
 * 두 오퍼레이션의 응답 스키마가 다르다. APT는 순위별 접수일이 따로 있고 통합
 * 접수일(RCEPT_ENDDE)을 주는데, 임의공급은 그 필드가 아예 없고 SUBSCRPT_RCEPT_*를
 * 쓴다. 날짜 표기도 APT는 "2026-08-24", 임의공급은 "20260813"으로 다르다.
 */
const SOURCES = [
  {
    type: "apt",
    operation: "getAPTLttotPblancDetail",
    label: "APT",
    receiptStart: "RCEPT_BGNDE",
    receiptEnd: "RCEPT_ENDDE",
  },
  {
    type: "arbitrary",
    operation: "getOptLttotPblancDetail",
    label: "임의공급",
    receiptStart: "SUBSCRPT_RCEPT_BGNDE",
    receiptEnd: "SUBSCRPT_RCEPT_ENDDE",
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kstToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

/** "2026-08-24"와 "20260813" 두 표기를 모두 YYYY-MM-DD로 맞춘다. */
function toIsoDate(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  // 잘못된 날짜(20260231 등)를 걸러낸다.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)) return null;
  return iso;
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeBase(name, value) {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name}이 URL 형식이 아닙니다: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name}의 프로토콜이 http(s)가 아닙니다: ${url.protocol}`);
  }
  return trimmed;
}

/** 다시 시도해도 결과가 같은 실패로 표시한다(인증 오류 등). */
function fatal(err) {
  err.fatal = true;
  return err;
}

async function withRetry(label, fn, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      if (attempt === attempts) break;
      const wait = attempt * Number(process.env.RETRY_BACKOFF_MS ?? 5000);
      console.warn(`[fetch-cheongyak] ${label} 실패(${attempt}/${attempts}), ${wait}ms 후 재시도: ${err.message}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function fetchPage(base, operation, page) {
  // serviceKey는 URLSearchParams에 넣지 않는다. 공공데이터포털 키에는 이미
  // %2B 같은 인코딩이 들어 있어서 한 번 더 인코딩되면 서명이 깨진다.
  const url = `${base}/${SERVICE}/${operation}?serviceKey=${API_KEY}&page=${page}&perPage=${PER_PAGE}`;

  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/1.0" } });
  } catch (err) {
    // undici는 DNS 실패든 TLS 오류든 "fetch failed" 한 줄만 던진다.
    const cause = err.cause?.message ?? err.cause?.code ?? "원인 불명";
    throw new Error(`${operation} p${page} 요청 실패: ${err.message} (${cause})`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${operation} p${page}: JSON 아님 (http ${res.status}) ${text.slice(0, 200)}`);
  }

  // odcloud는 인증키 문제를 code -4, 없는 서비스를 -3으로 알려준다. 둘 다
  // 다시 불러도 같은 답이 오므로 재시도하지 않는다.
  if (typeof json.code === "number" && json.code < 0) {
    throw fatal(new Error(`API 오류 ${json.code}: ${json.msg ?? ""}`.trim()));
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (!Array.isArray(json.data)) throw new Error(`${operation} p${page}: data 배열 없음`);

  return json;
}

async function fetchAll(base, source) {
  const rows = [];
  let page = 1;
  let totalCount = null;

  while (page <= MAX_PAGES) {
    const json = await withRetry(`${source.operation} p${page}`, () => fetchPage(base, source.operation, page));
    totalCount ??= json.totalCount;
    rows.push(...json.data);
    if (json.data.length === 0 || rows.length >= totalCount) break;
    page += 1;
  }

  if (totalCount && rows.length < totalCount) {
    console.warn(`[fetch-cheongyak] ${source.label}: ${totalCount}건 중 ${rows.length}건만 수집(MAX_PAGES 제한)`);
  }
  return rows;
}

function normalize(row, source) {
  const receiptEnd = toIsoDate(row[source.receiptEnd]);
  return {
    id: `${source.type}:${clean(row.HOUSE_MANAGE_NO) ?? clean(row.PBLANC_NO) ?? ""}`,
    type: source.type,
    name: clean(row.HOUSE_NM),
    // APT는 "APT"/"민영" 같은 세부 구분이 더 있고 임의공급은 HOUSE_SECD_NM만 있다.
    kind: clean(row.HOUSE_SECD_NM),
    detailKind: clean(row.HOUSE_DTL_SECD_NM),
    rentKind: clean(row.RENT_SECD_NM),
    area: clean(row.SUBSCRPT_AREA_CODE_NM),
    address: clean(row.HSSPLY_ADRES),
    units: Number.isFinite(row.TOT_SUPLY_HSHLDCO) ? row.TOT_SUPLY_HSHLDCO : null,
    builder: clean(row.CNSTRCT_ENTRPS_NM) ?? clean(row.BSNS_MBY_NM),
    tel: clean(row.MDHS_TELNO),
    noticeDate: toIsoDate(row.RCRIT_PBLANC_DE),
    receiptStart: toIsoDate(row[source.receiptStart]),
    receiptEnd,
    // 특별공급은 APT에만 있다(임의공급은 항상 null).
    specialStart: toIsoDate(row.SPSPLY_RCEPT_BGNDE),
    specialEnd: toIsoDate(row.SPSPLY_RCEPT_ENDDE),
    winnerDate: toIsoDate(row.PRZWNER_PRESNATN_DE),
    moveInMonth: clean(row.MVN_PREARNGE_YM),
    url: clean(row.PBLANC_URL),
    homepage: clean(row.HMPG_ADRES),
  };
}

async function main() {
  if (!API_KEY) throw new Error("CHEONGYAK_API_KEY 환경변수가 필요합니다");
  if (!API_BASE) throw new Error("CHEONGYAK_API_ENDPOINT 환경변수가 필요합니다");
  const base = normalizeBase("CHEONGYAK_API_ENDPOINT", API_BASE);

  const today = kstToday();
  const collected = [];
  const failed = [];

  for (const source of SOURCES) {
    try {
      const rows = await fetchAll(base, source);
      const normalized = rows.map((row) => normalize(row, source)).filter((item) => item.name);
      // 접수가 이미 끝난 공고는 뺀다. 마감일이 없는 공고도 카운트다운을 못 하니 뺀다.
      const open = normalized.filter((item) => item.receiptEnd && item.receiptEnd >= today);
      collected.push(...open);
      console.log(
        `[fetch-cheongyak] ${source.label}: 전체 ${rows.length} → 접수 중·예정 ${open.length}` +
          ` (마감일 없음 ${normalized.filter((i) => !i.receiptEnd).length})`
      );
    } catch (err) {
      if (err.fatal) throw err;
      failed.push(source.label);
      console.error(`[fetch-cheongyak] ${source.label} 수집 실패: ${err.message}`);
    }
  }

  if (failed.length === SOURCES.length) {
    throw new Error("모든 공고 종류 수집 실패 - 기존 데이터를 덮어쓰지 않고 중단합니다");
  }

  // 마감이 임박한 순. 같은 날이면 접수 시작이 빠른 쪽을 먼저 보여준다.
  collected.sort((a, b) => a.receiptEnd.localeCompare(b.receiptEnd) || (a.receiptStart ?? "").localeCompare(b.receiptStart ?? ""));

  let previous = {};
  try {
    previous = JSON.parse(await readFile(outFile, "utf-8"));
  } catch {
    // 최초 실행
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    baseDate: today,
    staleSources: failed,
    areas: [...new Set(collected.map((i) => i.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    notices: failed.length ? mergeWithPrevious(collected, previous, failed) : collected,
  };

  await mkdir(dataDir, { recursive: true });
  await writeFile(outFile, JSON.stringify(payload));

  console.log(`[fetch-cheongyak] 저장 완료 (${payload.notices.length}건, 기준일 ${today})`);
}

/** 한 종류가 실패하면 그 종류만 직전 데이터를 살려둔다. */
function mergeWithPrevious(collected, previous, failedLabels) {
  const failedTypes = SOURCES.filter((s) => failedLabels.includes(s.label)).map((s) => s.type);
  const kept = (previous.notices ?? []).filter((n) => failedTypes.includes(n.type));
  console.warn(`[fetch-cheongyak] 실패한 종류의 직전 데이터 ${kept.length}건 유지`);
  return [...collected, ...kept].sort((a, b) => (a.receiptEnd ?? "").localeCompare(b.receiptEnd ?? ""));
}

main().catch((err) => {
  console.error(`[fetch-cheongyak] ${err.message}`);
  process.exit(1);
});
