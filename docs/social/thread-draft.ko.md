# OAR 소개 쓰레드 초안 (정보 제공 위주)

> 플랫폼: X/Threads/LinkedIn 공통으로 쪼개 쓰기 좋게 번호 매김  
> 톤: 홍보 과장 최소화, 사실·한계 명시  
> 이미지: `oar-card-01` ~ `03` 순서 첨부 권장

---

## 이미지 배치

| 순서 | 파일 | 역할 |
|------|------|------|
| 1 | `oar-card-01-cover.png` | 커버 / 한 줄 정의 |
| 2 | `oar-card-02-problem-solution.png` | 문제 → OAR이 하는 일 |
| 3 | `oar-card-03-commands.png` | 설치·사용 3커맨드 |

---

## 쓰레드 본문 (한국어)

### 1/8 — 훅 + 정의
AI 코딩 에이전트를 쓰다 보면 “모델”보다 먼저 막히는 게 있습니다.

**계정.**

Grok / Codex / Claude를 여러 개 쓰면  
재로그인·재시작·한도 확인이 반복됩니다.

그래서 로컬 오픈소스로 **OAR (OMO Account Router)** 를 정리해 공개했습니다.  
에이전트가 고르는 건 모델, OAR이 고르는 건 **live auth 슬롯의 계정**입니다.

🔗 https://github.com/JIMyungSik/omo-account-router

(이미지 1)

---

### 2/8 — 무엇을 하는 도구인가
OAR은 모델 라우터가 아닙니다.

- vault에 계정 프로필을 여러 개 보관
- `oar use <provider> <profile>` 로 활성 계정 전환
- OMO/Senpi 계열은 보통 **다음 요청부터** 반영 (프로세스 재시작 없이)
- `oar usage` / `oar recommend` 로 잔여 %를 표로 확인

한 줄로: **account layer for coding agents.**

(이미지 2)

---

### 3/8 — 왜 재시작이 없나 (짧게 기술)
OMO/Senpi 경로 기준:

1. 에이전트 홈의 `auth.json` 에 provider당 슬롯 1개
2. 모델 호출 시마다 auth를 다시 읽음
3. OAR 데몬이 vault credential을 그 슬롯에 원자적으로 씀

그래서 같은 OMO 세션·병렬 터미널도 **같은 provider 슬롯을 공유**합니다.  
(창마다 다른 계정이 아니라, “지금 이 머신의 xAI 슬롯”이 바뀌는 구조입니다.)

---

### 4/8 — 잔여 % / 0% 보호
지원하는 범위에서:

- **Codex**: 주간(및 API가 주면 5h) remaining
- **xAI/Grok**: 구독 credits remaining

`oar recommend --refresh` 는 remaining이 높은 계정을 순위 표로 보여 줍니다.

또한 **0% / QUOTA_EXHAUSTED** 계정으로는  
`oar use` 가 기본적으로 거절됩니다. (auto여도 스킵)  
강제하려면 `--force` 가 필요합니다.

Grok 쪽 403 “out of credits” 도 quota 소진으로 분류하도록 맞춰 두었습니다.

---

### 5/8 — 다른 ADE는?
1순위 연동: **OMO / Senpi**

실험적: pi / omp / gjc 등 **Senpi형 auth.json** 을 쓰면  
`OAR_AUTH_PATH` 로 같은 전환을 시도할 수 있습니다.

부분/별도:

- Codex CLI · Claude Code → 포맷·홈이 달라 어댑터 단계
- Cursor · Copilot · Orca · Gemini CLI · Aider → 자체 계정 UI  
  (OAR이 대신 로그인 창을 바꾸진 않음)

자세한 표: repo의 `docs/ades.md` / `docs/ades.ko.md`

---

### 6/8 — 설치 (clone 없이)
Node 22+ 기준:

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
oar doctor
oar daemon start
oar import-auth --all
oar recommend --refresh
```

패키지 이름은 **`oar-cli`** 입니다.  
(npm 이름 `oar` 는 무관한 옛 패키지가 선점)  
설치 후 명령은 **`oar`**.

(이미지 3)

---

### 7/8 — 약관 / 한계 (중요)
정보 목적으로 분명히 적습니다.

- 로컬 툴이며, **본인 소유 계정** 전제
- 다중 구독 자동 로테이션은 provider Terms와 충돌할 수 있음
- auto failover 기본 off, compliance 문서 제공
- 법률 자문 아님 · MIT 라이선스

“한도 우회 만능툴”이 아니라  
**계정 vault + 전환 + 잔량 가시성** 도구로 쓰는 걸 권장합니다.

---

### 8/8 — 링크 / CTA
Repo / Release:

- https://github.com/JIMyungSik/omo-account-router  
- Release v0.1.4  

읽어볼 문서:

- README (EN/KO)
- docs/ades (다른 ADE)
- docs/compliance

피드백·이슈·PR 환영합니다.  
특히 Codex home 어댑터 / Claude Code 어댑터 수요가 있으면 알려 주세요.

---

## 짧은 단일 포스트 버전 (여백 적을 때)

AI 에이전트용 로컬 계정 라우터 **OAR** 공개.

모델 선택이 아니라 **auth 슬롯 계정**을 바꿉니다.  
OMO/Senpi에서 재시작 없이 `oar use`, 잔여 %는 `oar recommend`.  
0% 계정은 기본 거절.

```bash
npm i -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```

https://github.com/JIMyungSik/omo-account-router  
MIT · 약관 메모 포함 · 다른 ADE는 단계적 지원

---

## 영어 초안 (해외 스레드용, 요약)

1/  
Open-sourcing **OAR** — a local **account layer** for AI coding agents (OMO/Senpi first-class).  
Your agent picks the model. OAR picks which login sits in the live auth slot — often without restart.

2/  
`oar use xai sub` · `oar usage` · `oar recommend`  
Blocks 0%/exhausted accounts by default (even with auto).  
Not a model router. Not a hosted proxy.

3/  
Install (Node 22+):  
`npm i -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz`  
Binary name: `oar` (package: `oar-cli`)  
https://github.com/JIMyungSik/omo-account-router

---

## 발행 체크리스트

- [ ] 이미지 1→2→3 순서 첨부
- [ ] 첫 타래에 GitHub 링크
- [ ] “한도 무한/우회” 표현 쓰지 않기
- [ ] OMO 밖 ADE는 과대 약속하지 않기
- [ ] 필요 시 compliance 한 줄 유지
