
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.SUBSIDY_OUT_DIR
  ? path.resolve(process.env.SUBSIDY_OUT_DIR)
  : path.resolve(import.meta.dirname, "../docs/data");
const outFile = path.join(dataDir, "subsidy.json");

const API_KEY = process.env.SUBSIDY_API_KEY;
const API_BASE = process.env.SUBSIDY_API_ENDPOINT;
const SERVICE = "gov24/v3";

const PER_PAGE = 1000;
const MAX_PAGES = 20;

const HOUSING_FIELD = "주거·자립";
const HOUSING_WORDS = /주택|주거|전세|월세|임대주택|매입임대|보금자리|집수리|이사비|주거급여|기숙사|전월세/;
const NON_HOUSING_WORDS = /수산|어업|어촌|어선|선박|농기계|농기구|농지|농산물|화훼|과원|과수|축사|기자재|장비\s?임대|점포|사무실/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      console.warn(`[fetch-subsidy] ${label} 실패(${attempt}/${attempts}), ${wait}ms 후 재시도: ${err.message}`);
      await sleep(wait);
    }
  }
  throw lastError;
}

function normalizeBase(name, value) {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`${name}의 프로토콜이 http(s)가 아닙니다: ${url.protocol}`);
    }
  } catch {
    throw new Error(`${name}이 URL 형식이 아닙니다: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

async function fetchPage(base, endpoint, page) {
  const url = `${base}/${SERVICE}/${endpoint}?serviceKey=${API_KEY}&page=${page}&perPage=${PER_PAGE}`;

  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/1.0" } });
  } catch (err) {
    const cause = err.cause?.message ?? err.cause?.code ?? "원인 불명";
    throw new Error(`${endpoint} p${page} 요청 실패: ${err.message} (${cause})`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} p${page}: JSON 아님 (http ${res.status}) ${text.slice(0, 200)}`);
  }
  if (typeof json.code === "number" && json.code < 0) {
    throw fatal(new Error(`API 오류 ${json.code}: ${json.msg ?? ""}`.trim()));
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (!Array.isArray(json.data)) throw new Error(`${endpoint} p${page}: data 배열 없음`);
  return json;
}

async function fetchAll(base, endpoint) {
  const rows = [];
  let page = 1;
  let totalCount = null;

  while (page <= MAX_PAGES) {
    const json = await withRetry(`${endpoint} p${page}`, () => fetchPage(base, endpoint, page));
    totalCount ??= json.totalCount;
    rows.push(...json.data);
    if (json.data.length === 0 || rows.length >= totalCount) break;
    page += 1;
  }
  if (totalCount && rows.length < totalCount) {
    console.warn(`[fetch-subsidy] ${endpoint}: ${totalCount}건 중 ${rows.length}건만 수집(MAX_PAGES 제한)`);
  }
  console.log(`[fetch-subsidy] ${endpoint}: ${rows.length}건 (전체 ${totalCount})`);
  return rows;
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

function isHousing(row) {
  if (clean(row["서비스분야"]) === HOUSING_FIELD) return true;
  const haystack = `${row["서비스명"] ?? ""} ${row["서비스목적요약"] ?? ""}`;
  return HOUSING_WORDS.test(haystack) && !NON_HOUSING_WORDS.test(haystack);
}

const INCOME_BRACKETS = [
  ["JA0201", "0~50%"],
  ["JA0202", "51~75%"],
  ["JA0203", "76~100%"],
  ["JA0204", "101~200%"],
  ["JA0205", "200% 초과"],
];

const REGIONS = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "대전광역시", "울산광역시",
  "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
  "전북특별자치도", "전라남도", "광주광역시", "전남광주통합특별시",
  "경상북도", "경상남도", "제주특별자치도",
];
const REGION_PREFIXES = REGIONS.map((name) => ({ name, prefix: name.replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, "") }))
  .sort((a, b) => b.prefix.length - a.prefix.length);

function regionOf(row) {
  const type = clean(row["소관기관유형"]);
  if (type === "중앙행정기관" || type === "공공기관") return "전국";

  const agency = clean(row["소관기관명"]) ?? "";
  for (const { name, prefix } of REGION_PREFIXES) {
    if (agency.startsWith(name) || agency.startsWith(prefix)) return name;
  }
  return null;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function conditionsOf(row) {
  if (!row) return null;
  const income = INCOME_BRACKETS.filter(([code]) => row[code] === "Y").map(([, label]) => label);
  const ageFrom = toNumberOrNull(row.JA0110);
  const ageTo = toNumberOrNull(row.JA0111);
  const ageLimited = ageFrom !== null && ageTo !== null && !(ageFrom <= 0 && ageTo >= 120);

  return {
    income: income.length === INCOME_BRACKETS.length ? [] : income,
    ageFrom: ageLimited ? ageFrom : null,
    ageTo: ageLimited ? ageTo : null,
  };
}

function excerpt(value, limit) {
  const text = clean(value);
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function main() {
  if (!API_KEY) throw new Error("SUBSIDY_API_KEY 환경변수가 필요합니다");
  if (!API_BASE) throw new Error("SUBSIDY_API_ENDPOINT 환경변수가 필요합니다");
  const base = normalizeBase("SUBSIDY_API_ENDPOINT", API_BASE);

  const [services, conditions] = await Promise.all([
    fetchAll(base, "serviceList"),
    fetchAll(base, "supportConditions"),
  ]);

  const conditionById = new Map(conditions.map((row) => [row["서비스ID"], row]));

  const housing = services.filter(isHousing);
  const items = housing.map((row) => {
    const id = clean(row["서비스ID"]);
    return {
      id,
      name: clean(row["서비스명"]),
      summary: excerpt(row["서비스목적요약"], 200),
      field: clean(row["서비스분야"]),
      target: excerpt(row["지원대상"], 200),
      content: excerpt(row["지원내용"], 300),
      supportType: clean(row["지원유형"]),
      applyMethod: clean(row["신청방법"]),
      deadline: clean(row["신청기한"]),
      agency: clean(row["소관기관명"]),
      agencyType: clean(row["소관기관유형"]),
      region: regionOf(row),
      receiver: clean(row["접수기관"]),
      tel: clean(row["전화문의"]),
      url: clean(row["상세조회URL"]),
      conditions: conditionsOf(conditionById.get(id)),
    };
  });

  items.sort((a, b) => {
    const rank = (item) => (item.agencyType === "중앙행정기관" ? 0 : 1);
    return rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? "", "ko");
  });

  const byField = {};
  for (const item of items) byField[item.field ?? "(없음)"] = (byField[item.field ?? "(없음)"] ?? 0) + 1;
  console.log(`[fetch-subsidy] 주거 관련 ${items.length}건 / 전체 ${services.length}건`);
  for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
    console.log(`[fetch-subsidy]   ${field}: ${count}`);
  }
  const withConditions = items.filter((i) => i.conditions).length;
  console.log(`[fetch-subsidy] 자격 조건이 붙은 건: ${withConditions}/${items.length}`);
  const unknownRegion = items.filter((i) => !i.region);
  console.log(`[fetch-subsidy] 지역 미상: ${unknownRegion.length}건`);
  for (const item of unknownRegion.slice(0, 5)) {
    console.warn(`[fetch-subsidy]   지역 못 찾음: ${item.agency} (${item.agencyType})`);
  }

  if (items.length === 0) {
    throw new Error("주거 관련 지원금이 0건 - 기존 데이터를 덮어쓰지 않고 중단합니다");
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    outFile,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      total: services.length,
      fields: [...new Set(items.map((i) => i.field).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
      regions: [
        ...(items.some((i) => i.region === "전국") ? ["전국"] : []),
        ...[...new Set(items.map((i) => i.region).filter((r) => r && r !== "전국"))].sort((a, b) => a.localeCompare(b, "ko")),
      ],
      items,
    })
  );

  console.log("[fetch-subsidy] 저장 완료");
}

main().catch((err) => {
  console.error(`[fetch-subsidy] ${err.message}`);
  process.exit(1);
});
