// GA4 로더. econ-realestate-digest의 같은 파일에서 가져왔고, 사이트 이름만
// <meta name="site-group">으로 갈린다. 광고는 붙이지 않으므로 애드센스 부분은 뺐다.
//
// 페이지뷰는 자동 전송을 끄고 렌더가 끝난 쪽에서 부른다. 렌더가 실패해 아무도
// 안 부르는 경우를 대비해 아래 타이머가 대신 보낸다.
(function () {
  const GA_MEASUREMENT_ID = "G-Z1LH7S1ZE5";
  const PAGE_VIEW_FALLBACK_MS = 4000;
  const SEARCH_DEBOUNCE_MS = 800;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;

  gtag("js", new Date());

  // 배포된 사이트에서 이벤트가 실제로 나가는지 GA DebugView로 보려면 이게 있어야 한다.
  // 주소에 ?ga_debug=1을 붙였을 때만 켠다 — 늘 켜두면 일반 방문까지 디버그 스트림으로 샌다.
  const debugMode = new URLSearchParams(location.search ?? "").has("ga_debug");
  // 같은 GA 속성을 블로그·다른 프로젝트 페이지와 함께 쓰기 때문에, 이 값이 없으면
  // 보고서에서 전부 한 덩어리로 섞인다. 이 파일을 다른 프로젝트에 그대로 복사해
  // 쓸 수 있도록 사이트 이름은 파일에 박지 않고 페이지의 meta에서 읽는다.
  const siteGroup = document.querySelector('meta[name="site-group"]')?.getAttribute("content");

  gtag("config", GA_MEASUREMENT_ID, {
    send_page_view: false,
    ...(siteGroup ? { content_group: siteGroup } : {}),
    ...(debugMode ? { debug_mode: true } : {}),
  });

  let pageViewSent = false;

  // 언어를 바꾸면 다시 불리지만, 주소가 그대로인 같은 방문이라 두 번 세면
  // 조회수만 부풀려진다. 첫 호출만 보내고 언어 전환 자체는 이벤트로 남긴다.
  function pageView(params) {
    if (pageViewSent) return;
    pageViewSent = true;
    gtag("event", "page_view", {
      page_title: document.title,
      page_location: location.href,
      ...params,
    });
  }

  function event(name, params) {
    gtag("event", name, params ?? {});
  }

  // 검색은 글자마다 input이 떨어져서 그대로 보내면 이벤트가 폭발한다.
  const debounceTimers = {};
  function debouncedEvent(name, params, delay) {
    clearTimeout(debounceTimers[name]);
    debounceTimers[name] = setTimeout(() => event(name, params), delay ?? SEARCH_DEBOUNCE_MS);
  }

  window.analytics = { pageView, event, debouncedEvent };

  setTimeout(() => pageView(), PAGE_VIEW_FALLBACK_MS);

  const gaScript = document.createElement("script");
  gaScript.async = true;
  gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(gaScript);

})();
