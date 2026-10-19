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
  };
})();
