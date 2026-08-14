// 정부24 공공서비스(보조금24) 중 주거 관련만 추려 docs/data/subsidy.json에 쓴다.
//
// 청약과 달리 마감 카운트다운을 붙이지 않는다. `신청기한`이 날짜인 경우가
// 100건 중 5건뿐이고 나머지는 "상시신청", "연초 모집공고에 따름" 같은 문장이라
// D-day를 셀 대상이 아니다. 대신 supportConditions의 자격 조건 코드로 거른다.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.SUBSIDY_OUT_DIR
  ? path.resolve(process.env.SUBSIDY_OUT_DIR)
  : path.resolve(import.meta.dirname, "../docs/data");
const outFile = path.join(dataDir, "subsidy.json");

const API_KEY = process.env.SUBSIDY_API_KEY;
const API_BASE = process.env.SUBSIDY_API_ENDPOINT;
const SERVICE = "gov24/v3";

// perPage는 1000이 상한이다(5000을 넣으면 data 없이 "정상"만 돌아온다).
// 전체 약 11,000건이라 목록·조건 각각 11페이지면 받아진다.
const PER_PAGE = 1000;
const MAX_PAGES = 20;

// 분야만 보면 놓치고(“긴급복지 주거지원”은 분야가 생활안정) 낱말만 보면
// 오탐이 붙는다(“수산장비 임대”, “청년어촌정착지원”). 둘을 합쳐서 거른다.
const HOUSING_FIELD = "주거·자립";
const HOUSING_WORDS = /주택|주거|전세|월세|임대주택|매입임대|보금자리|집수리|이사비|주거급여|기숙사|전월세|임차/;
const NON_HOUSING_WORDS = /수산|어업|어촌|어선|농기계|장비\s?임대|선박/;

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
  // serviceKey는 raw로 붙인다. 공공데이터포털 키에는 이미 인코딩이 들어 있어서
  // URLSearchParams로 넣으면 한 번 더 인코딩돼 서명이 깨진다.
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
  // 지원내용·지원대상은 줄바꿈과 ○, - 기호가 섞인 긴 글이라 공백만 정리한다.
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

function isHousing(row) {
  if (clean(row["서비스분야"]) === HOUSING_FIELD) return true;
  const haystack = `${row["서비스명"] ?? ""} ${row["서비스목적요약"] ?? ""}`;
  return HOUSING_WORDS.test(haystack) && !NON_HOUSING_WORDS.test(haystack);
}

/**
 * 자격 조건 코드를 화면에서 쓸 수 있는 형태로 줄인다.
 *
 * 무주택세대(JA0412)는 일부러 뺐다. 표본 1,000건 중 550건에 붙어 있어서
 * (유아학비, 근로장려금까지 Y) 거르는 데 아무 도움이 안 된다. "무주택자 전용"이
 * 아니라 "무주택세대도 대상"이라는 뜻이기 때문이다.
 */
const CONDITION_FLAGS = [
  ["singleParent", "JA0403", "한부모·조손"],
  ["singlePerson", "JA0404", "1인가구"],
  ["multiChild", "JA0411", "다자녀"],
  ["newResident", "JA0413", "신규 전입"],
  ["pregnant", "JA0302", "임산부"],
  ["birth", "JA0303", "출산·입양"],
  ["worker", "JA0326", "근로자"],
  ["jobSeeker", "JA0327", "구직자"],
  ["student", "JA0320", "대학생"],
  ["disabled", "JA0328", "장애인"],
  ["veteran", "JA0329", "국가보훈"],
  ["multicultural", "JA0401", "다문화"],
  ["defector", "JA0402", "북한이탈주민"],
];

const INCOME_BRACKETS = [
  ["JA0201", "0~50%"],
  ["JA0202", "51~75%"],
  ["JA0203", "76~100%"],
  ["JA0204", "101~200%"],
  ["JA0205", "200% 초과"],
];

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function conditionsOf(row) {
  if (!row) return null;
  const flags = CONDITION_FLAGS.filter(([, code]) => row[code] === "Y").map(([key]) => key);
  const income = INCOME_BRACKETS.filter(([code]) => row[code] === "Y").map(([, label]) => label);
  const ageFrom = toNumberOrNull(row.JA0110);
  const ageTo = toNumberOrNull(row.JA0111);

  return {
    flags,
    // 모든 소득 구간이 Y면 소득 제한이 없다는 뜻이라 표시할 값이 없다.
    income: income.length === INCOME_BRACKETS.length ? [] : income,
    ageFrom,
    ageTo,
  };
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
      summary: clean(row["서비스목적요약"]),
      field: clean(row["서비스분야"]),
      target: clean(row["지원대상"]),
      criteria: clean(row["선정기준"]),
      content: clean(row["지원내용"]),
      supportType: clean(row["지원유형"]),
      applyMethod: clean(row["신청방법"]),
      // 날짜가 아니라 문장인 경우가 대부분이라 그대로 보여준다.
      deadline: clean(row["신청기한"]),
      agency: clean(row["소관기관명"]),
      agencyType: clean(row["소관기관유형"]),
      receiver: clean(row["접수기관"]),
      tel: clean(row["전화문의"]),
      url: clean(row["상세조회URL"]),
      conditions: conditionsOf(conditionById.get(id)),
    };
  });

  // 상시로 열려 있는 것이 대부분이라 마감순 정렬이 불가능하다. 소관기관 유형이
  // 중앙행정기관인 쪽이 대체로 규모가 크므로 그것을 앞에 두고 이름순으로 묶는다.
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
      items,
    })
  );

  console.log("[fetch-subsidy] 저장 완료");
}

main().catch((err) => {
  console.error(`[fetch-subsidy] ${err.message}`);
  process.exit(1);
});
