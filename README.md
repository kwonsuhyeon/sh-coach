# SH 코치 (coach-pwa)

PC를 켜지 않은 날에도 폰으로 기록하고 오늘의 논문을 펼치게 해 주는 개인용 웹앱입니다.
이 저장소에는 화면 코드만 있고, 개인 기록은 올라가지 않습니다.

- 기록은 폰에서 Dropbox 앱 폴더(`Apps/sh-coach`)로 바로 올라갑니다. 이 앱은 그 폴더 밖의 파일을 볼 수 없습니다.
- PC가 켜지면 로컬 위키 서버가 Dropbox 동기화로 기록을 받아 하루 노트에 합치고, 폰이 읽을 요약(`snapshot.json`)을 다시 써 둡니다.
- 오프라인에서도 앱이 열리고 입력이 됩니다. 기록은 폰 안에 쌓였다가 연결되면 올라갑니다.

## 구조

```
폰(이 앱) ──Dropbox API──> Apps/sh-coach/events/*.json    (폰만 만든다, 덮어쓰기 없음)
폰(이 앱) <──Dropbox API── Apps/sh-coach/snapshot.json     (PC만 쓴다)
```

## Dropbox 앱 설정 (한 번만)

1. https://www.dropbox.com/developers/apps → Create app → Scoped access → **App folder** → 이름 `sh-coach`
2. Permissions: `files.metadata.read` · `files.content.read` · `files.content.write` → Submit
3. Settings → Redirect URIs: `https://kwonsuhyeon.github.io/sh-coach/`, `http://localhost:4797/`
4. Allow public clients (PKCE) = Allow
5. App key를 `config.js`에 넣는다. **App secret은 어디에도 넣지 않는다.**

App key는 공개돼도 됩니다. 접근 권한은 사용자가 Dropbox 화면에서 직접 허용해야 생기고, 등록된 주소로만 돌아옵니다.

## 폰을 잃어버렸을 때

Dropbox 웹 → 설정 → 연결된 앱 → `sh-coach` 연결 해제. 폰에 남은 토큰이 바로 무효가 됩니다.

## 개발

```
python -m http.server 4797 --bind 127.0.0.1
```

`http://localhost:4797/`에서는 앱 폴더 안의 `/test` 아래만 씁니다(실제 기록과 섞이지 않음).
`?demo`를 붙이면 같은 폴더의 `demo-snapshot.json`으로 화면만 그립니다(localhost 전용, 파일은 저장소에 넣지 않음).
화면 파일을 고치면 `sw.js`의 `VERSION`을 올립니다.
