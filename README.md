# housing-subsidy-radar

전국 청약 공고와 주거 지원금을 매일 모아 보여주는 GitHub Pages 정적 사이트.

사이트: https://kyhsa93.github.io/housing-subsidy-radar/

## 두 탭이 성격이 다르다

**청약 마감** — 접수 마감일 카운트다운이다. APT와 임의공급 공고 중 아직 접수가
끝나지 않은 것만 담고 마감 임박순으로 정렬한다.

**주거 지원금** — 카운트다운이 없다. 정부24 `신청기한`을 100건 표본으로 확인해
보니 날짜인 경우가 5건뿐이고 나머지는 "상시신청", "연초 모집공고에 따름" 같은
문장이라 셀 대상이 없다. 그래서 분야·소득·나이·검색으로 좁혀 보는 목록이다.

## 구조

- `scripts/fetch-cheongyak.mjs` — 청약홈 APT(`getAPTLttotPblancDetail`)와
  임의공급(`getOptLttotPblancDetail`) 수집 → `docs/data/cheongyak.json`.
  두 오퍼레이션의 응답 스키마가 다르다: APT는 순위별 접수일과 통합 마감일
  (`RCEPT_ENDDE`)을 주는데 임의공급은 `SUBSCRPT_RCEPT_*`만 있고, 날짜 표기도
  `2026-08-24`와 `20260813`으로 갈린다. 둘 다 ISO로 맞춘 뒤 비교한다
- `scripts/fetch-subsidy.mjs` — 정부24 공공서비스(`gov24/v3/serviceList` +
  `supportConditions`) 중 주거 관련만 추려 `docs/data/subsidy.json`
- `docs/index.html` — 단일 파일 정적 페이지. 지원금 데이터가 수백 KB라 그 탭을
  처음 열 때만 받는다
- `.github/workflows/update.yml` — 매일 06:20 KST 수집 → 커밋 → Pages 배포

## 알아둘 것

**대상 구분 조건(JA0101~)은 필터로 못 쓴다.** 주거 지원금 775건 기준으로 장애인
60%, 대학생 56%, 근로자 56%, 다자녀 47%처럼 모든 항목이 절반 안팎에서 `Y`다.
"그 대상에게 주는 지원"이 아니라 "그 대상을 배제하지 않음"이라서, 걸러도 절반이
그대로 남는다. 무주택세대(`JA0412`)도 마찬가지다. 실제로 변별되는 건 연령 범위와
소득 구간뿐이라 그 둘만 저장한다(`0~120`은 제한 없음이므로 정규화해서 버린다).

**주거 판정은 분야와 낱말을 함께 본다.** 분야만 보면 `긴급복지 주거지원`(생활안정)을
놓치고, 낱말만 보면 `화훼류 기자재 임차` 같은 게 딸려온다.

## 시크릿

| 이름 | 값 |
| --- | --- |
| `CHEONGYAK_API_KEY` | 공공데이터포털 서비스키(Decoding) |
| `CHEONGYAK_API_ENDPOINT` | `https://api.odcloud.kr/api` |
| `SUBSIDY_API_KEY` | 공공데이터포털 서비스키(Decoding) |
| `SUBSIDY_API_ENDPOINT` | `https://api.odcloud.kr/api` |

엔드포인트에는 서비스 경로(`ApplyhomeInfoDetailSvc/v1`, `gov24/v3`)와 오퍼레이션을
넣지 않는다. 오퍼레이션을 바꾸거나 같은 제공처의 다른 API를 쓸 때 시크릿을 건드리지
않아도 된다.

호출량은 하루 22회 남짓이다(청약 각 1페이지, 지원금 11페이지 × 2). 개발계정 한도는
청약홈 40,000건, 정부24 10,000건이다.
