
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.CHEONGYAK_OUT_DIR
  ? path.resolve(process.env.CHEONGYAK_OUT_DIR)
  : path.resolve(import.meta.dirname, "../docs/data");
const outFile = path.join(dataDir, "cheongyak.json");

const API_KEY = process.env.CHEONGYAK_API_KEY;
const API_BASE = process.env.CHEONGYAK_API_ENDPOINT;
const SERVICE = "ApplyhomeInfoDetailSvc/v1";

const PER_PAGE = 500;
const MAX_PAGES = 30;

const SOURCES = [
  {
    type: "apt",
    operation: "getAPTLttotPblancDetail",
    label: "APT",
    receiptStart: ["RCEPT_BGNDE"],
    receiptEnd: ["RCEPT_ENDDE"],
  },
  {
    type: "arbitrary",
    operation: "getOptLttotPblancDetail",
    label: "임의공급",
    receiptStart: ["SUBSCRPT_RCEPT_BGNDE", "GNRL_RCEPT_BGNDE"],
    receiptEnd: ["SUBSCRPT_RCEPT_ENDDE", "GNRL_RCEPT_ENDDE"],
  },
  {
    type: "remndr",
    operation: "getRemndrLttotPblancDetail",
    label: "무순위·잔여세대",
    receiptStart: ["SUBSCRPT_RCEPT_BGNDE", "GNRL_RCEPT_BGNDE"],
    receiptEnd: ["SUBSCRPT_RCEPT_ENDDE", "GNRL_RCEPT_ENDDE"],
  },
  {
    type: "urbty",
    operation: "getUrbtyOfctlLttotPblancDetail",
    label: "오피스텔·도시형",
    receiptStart: ["SUBSCRPT_RCEPT_BGNDE"],
    receiptEnd: ["SUBSCRPT_RCEPT_ENDDE"],
    kindFields: ["HOUSE_DTL_SECD_NM", "HOUSE_SECD_NM"],
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kstToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function toIsoDate(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
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
  const url = `${base}/${SERVICE}/${operation}?serviceKey=${API_KEY}&page=${page}&perPage=${PER_PAGE}`;

  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/1.0" } });
  } catch (err) {
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

function pickDate(row, fields) {
  for (const field of fields) {
    const iso = toIsoDate(row[field]);
    if (iso) return iso;
  }
  return null;
}

function pickText(row, fields) {
  for (const field of fields) {
    const value = clean(row[field]);
    if (value) return value;
  }
  return null;
}

function normalize(row, source) {
  const receiptEnd = pickDate(row, source.receiptEnd);
  return {
    id: `${source.type}:${clean(row.HOUSE_MANAGE_NO) ?? clean(row.PBLANC_NO) ?? ""}`,
    type: source.type,
    name: clean(row.HOUSE_NM),
    kind: pickText(row, source.kindFields ?? ["HOUSE_SECD_NM"]),
    detailKind: clean(row.HOUSE_DTL_SECD_NM),
    rentKind: clean(row.RENT_SECD_NM),
    area: clean(row.SUBSCRPT_AREA_CODE_NM),
    address: clean(row.HSSPLY_ADRES),
    units: Number.isFinite(row.TOT_SUPLY_HSHLDCO) ? row.TOT_SUPLY_HSHLDCO : null,
    builder: clean(row.CNSTRCT_ENTRPS_NM) ?? clean(row.BSNS_MBY_NM),
    tel: clean(row.MDHS_TELNO),
    noticeDate: toIsoDate(row.RCRIT_PBLANC_DE),
    receiptStart: pickDate(row, source.receiptStart),
    receiptEnd,
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

  collected.sort((a, b) => a.receiptEnd.localeCompare(b.receiptEnd) || (a.receiptStart ?? "").localeCompare(b.receiptStart ?? ""));

  let previous = {};
  try {
    previous = JSON.parse(await readFile(outFile, "utf-8"));
  } catch {
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
