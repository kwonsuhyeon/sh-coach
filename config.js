// coach-pwa 설정 — 공개 저장소에 올라가도 되는 값만 둔다.
// DROPBOX_APP_KEY는 PKCE 방식이라 공개돼도 된다 (App secret은 어디에도 넣지 않는다).
// REDIRECT_URI는 Dropbox App Console > Settings > Redirect URIs에 등록한 주소와 글자 하나까지 같아야 한다.
window.COACH_CONFIG = (() => {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return {
    DROPBOX_APP_KEY: '1uk2gejub1tqg4z',
    REDIRECT_URI: local ? `http://localhost:${location.port}/` : 'https://kwonsuhyeon.github.io/sh-coach/',
    // 앱 폴더(Apps/sh-coach) 안의 기준 경로. 개발 서버에서는 /test 아래만 써서 실제 기록과 섞이지 않게 한다.
    COACH_ROOT: local ? '/test' : '',
    DAY_CUTOFF_H: 3,   // daily-wiki와 같은 규칙: 새벽 3시 전은 어제
    WATER_GOAL: 7,     // 하루 물 목표(잔) — PC 요약 trend.waterGoal이 오면 그 값이 우선
    // 💬 코치 대화 (PRD tasks/prd-coach-chat.md) — 키는 여기 두지 않는다(폰에서 직접 넣고 암호화 저장)
    CHAT_API: 'https://api.anthropic.com/v1/messages',
    CHAT_MODEL: 'claude-sonnet-5-5',   // 호호 결정 2026-11-20
    CHAT_EFFORT: 'low',                // 짧은 대화라 low로 충분 — 생각 토큰(출력 요금)도 줄인다
    CHAT_MAX_TURNS: 12,                // 대화 하나에 요청 12번까지
    CHAT_MAX_DAILY: 60,                // 하루(새벽 3시 기준) 요청 60번까지
  };
})();
