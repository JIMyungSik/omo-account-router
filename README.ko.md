# OAR — OMO Account Router

**언어:** [English](README.md) · [한국어](README.ko.md)

AI 코딩 에이전트(**OMO / Senpi** 우선)용 **로컬 멀티 계정 핫스왑** 도구입니다.

- 모델/provider 선택은 에이전트가 합니다  
- OAR은 live auth 슬롯에 **어느 계정을 올릴지** 고릅니다  
- 대개 **재시작 없이** 다음 요청부터 반영됩니다  

```text
사용자  →  omo / senpi  →  모델 요청
                              ↑ 요청마다 getAuth
                         ~/.omo/agent/auth.json   ← provider당 슬롯 1개
                              ↑ 원자적 활성화
oar CLI  ──UDS──  oar-daemon  ──  ~/.oar/vault + state
```

| | |
|--|--|
| 패키지명 | **`oar-cli`** (실행 명령은 **`oar`**) |
| 버전 | `0.1.7` |
| 라이선스 | [MIT](LICENSE) |
| 런타임 | Node.js **22+** (개발 시 Bun 선택) |
| 테스트 | `bun test` |
| 약관 메모 | [docs/compliance.md](docs/compliance.md) (**법률 자문 아님**) |
| 저장소 | https://github.com/JIMyungSik/omo-account-router |

> npm 이름 `oar` 는 무관한 옛 패키지가 선점 중입니다. **`oar-cli`** 로 설치하고, 명령은 **`oar`** 를 쓰세요.

**OMO `5.0.0-0.beta.42` / Senpi `2026.9.4-3`** 기준: `after_provider_response`는 status+headers만 오므로 헤더에서 `invalid_grant`를 읽고, live `auth.json` 기록은 native `accounts` 필드를 덮어쓰지 않습니다.


---

## 설치 (clone 불필요)

### 권장 — GitHub 아카이브

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```

**Node.js 22+** 필요.

```bash
oar doctor
oar daemon start
oar panel --refresh
oar recommend --refresh
```

### npm 레지스트리 배포 후

```bash
npm install -g oar-cli
```

### macOS 상시 daemon + Senpi 확장 (선택)

```bash
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build
# 또는 설치 소스가 tarball이면:
bash "$(npm root -g)/omo-account-router/scripts/install.sh" --skip-build
```

### 제거

```bash
npm uninstall -g oar-cli
# 또는
npm uninstall -g omo-account-router
```

### 개발용 clone (Bun)

```bash
git clone https://github.com/JIMyungSik/omo-account-router.git
cd omo-account-router
bun install && bun test && bun run build
bash scripts/install.sh --import-auth
```

---

## 바로 쓰기

```bash
# 현황
oar                         # 인자 없이 빠른 status
oar status
oar panel --refresh         # 표: 활성 슬롯 + 로컬 신호 + 원격 %
oar usage --refresh         # Codex 5h/주간 + Grok 구독 잔여
oar recommend --refresh     # 다음에 쓸 계정 순위 표

# 현재 로그인 vault 적재
oar import-auth --all

# 계정 전환 (핫스왑)
oar use xai sub
oar use openai-codex main

# 0% 계정은 거절 (auto 켜져 있어도)
oar use xai main            # 0%면 REFUSED
oar use xai main --force    # 강제 (비권장)

# provider 안 자동 failover (기본 off — compliance 읽을 것)
oar auto xai on
oar auto xai off
```

### 같은 provider에 2번째 계정

**격리 로그인에 `omo` 쓰지 마세요.** 런처가 항상 `~/.omo/agent` 를 씁니다.

```bash
oar import-auth xai main
export OAR_TMP="$(mktemp -d)/agent" && mkdir -p "$OAR_TMP"
SENPI_CODING_AGENT_DIR="$OAR_TMP" senpi
# TUI: /login → provider → 2번 계정 → 종료
oar import-auth xai sub --from "$OAR_TMP/auth.json"
rm -rf "$(dirname "$OAR_TMP")"
oar use xai main
```

전체 가이드: `oar guide second-account` · [scripts/second-account.md](scripts/second-account.md)

## Argo · Buzz에 붙이기

OAR을 복제하지 않습니다. vault는 하나이고, `oar use`가 OMO `auth.json` 외에 **이미 있는** Argo/Codex 파일만 이중기록합니다. 설계: [docs/sinks.md](docs/sinks.md)

전제:

1. `oar daemon start` (LaunchAgent면 이미 켜져 있음 → `oar doctor`)
2. 쓸 계정이 vault에 있음 (`oar import-auth` / `oar status`)
3. **대상 앱을 한 번은 직접 로그인**해 둔 상태. OAR은 설치·로그인 파일을 새로 만들지 않습니다.

### Argo (Grok / xAI)

Argo Grok runner는 Senpi `auth.json`이 아니라 이런 JSON입니다.

`~/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json`  
워크스페이스 `…/workspaces/<id>/.secrets.json`

```json
"runners": {
  "grok": { "type": "oauth", "value": "{\"access_token\",\"refresh_token\",\"expires_at\"}" },
  "codex": { "type": "host", "value": "auto" }
}
```

절차:

```bash
# 1) OMO에 로그인된 xAI를 vault에 넣기
oar import-auth xai main
# 두 번째 계정이면 oar guide second-account 후:
# oar import-auth xai sub --from "$OAR_TMP/auth.json"

oar status          # xai/main, xai/sub 보이는지

# 2) 전환 — OMO 슬롯 + Argo runners.grok 동시 기록
oar use xai sub

# 3) Argo가 시작 시 시크릿을 캐시하면 앱을 한 번 재시작
```

확인:

- `oar doctor` 가 daemon ok
- Argo에서 Grok runner가 막히지 않는지 (토큰 본문은 열지 말 것)
- 안 바뀌면 Argo 재시작. 그래도 안 되면 `OAR_ARGO_SECRETS_PATH`로 실제 secrets 파일을 가리키기

끄기: `OAR_ARGO_SINK=0` 또는 `OAR_SINKS=0` 후 daemon 재시작.

Argo **Codex**는 `type: host`라 호스트 Codex 로그인을 씁니다. 그건 아래 Buzz Codex와 같은 `~/.codex` 경로입니다.

### Buzz (Codex만)

이 머신에서 Buzz Codex 에이전트는 `runtime: codex` / `codex-acp`이고 `CODEX_HOME`을 안 넣습니다. 호스트 CLI 홈인 **`~/.codex/auth.json`** 을 읽습니다.

Buzz **Grok**은 `runtime: cursor` (Cursor 풀 + `CURSOR_API_KEY`)라 OAR xAI 슬롯과 다른 계정입니다. Grok을 OAR로 바꾸지 않습니다.

절차:

```bash
oar import-auth openai-codex main
# 두 번째 Codex 계정이면 second-account 가이드 후 sub 로 import

oar use openai-codex sub

# Buzz Codex 에이전트는 다음 턴부터 ~/.codex/auth.json 을 읽음
# 안 바뀌면 Buzz 재시작 또는 새 Codex 세션
```

`CODEX_HOME`을 Buzz가 따로 쓰면:

```bash
export CODEX_HOME=/path/to/that/home
# 또는
export OAR_CODEX_HOME=/path/to/that/home
oar daemon stop; oar daemon start
oar use openai-codex sub
```

테스트/비기본 경로:

| 변수 | 역할 |
|------|------|
| `OAR_SINKS=0` | Argo+Codex sink 전부 끔 |
| `OAR_ARGO_SINK=0` | Argo만 끔 |
| `OAR_CODEX_SINK=0` | Codex 홈만 끔 |
| `OAR_ARGO_SECRETS_PATH` | Argo secrets JSON 한 파일 |
| `OAR_CODEX_AUTH_PATH` | Codex `auth.json` 직접 지정 |
| `CODEX_HOME` / `OAR_CODEX_HOME` | `…/auth.json` 의 부모 디렉터리 |

한계 (의도):

- Argo/Buzz 안에서 한도 초과 시 OAR auto-failover는 **안** 돕니다. 그건 OMO extension만.
- sink 쓰기가 실패해도 OMO `auth.json` 기록은 롤백하지 않습니다.
- 파일이 없으면 skip. `touch`로 빈 파일을 만들지 마세요.

---

## 명령어

| 명령 | 설명 |
|------|------|
| `oar` | 빠른 status |
| `oar status` | 프로필 + 활성 `*` |
| `oar panel [--refresh] [--watch N] [--json] [--xbar]` | 대시보드 표 |
| `oar usage [provider] [profile] [--refresh]` | 잔여 % 표 |
| `oar recommend [--refresh] [provider...]` | 잔여 % 기준 순위 표 |
| `oar accounts [provider]` | JSON 목록 |
| `oar import-auth …` / `--all` | vault 적재 |
| `oar use <p> <profile> [--force]` | 전환 (0% 거절) |
| `oar auto <p> on\|off` | auto failover |
| `oar doctor` | 경로·엔진·daemon |
| `oar daemon start\|stop\|status` | 데몬 |
| `oar guide second-account` | 2계정 가이드 |

환경 변수: `OAR_HOME`, `OAR_SOCK`, `OAR_AUTH_PATH`, `OAR_ACTIVATE_ALL=1`, `OAR_SINKS`, `OAR_ARGO_SINK`, `OAR_CODEX_SINK`, `OAR_ARGO_SECRETS_PATH`, `OAR_CODEX_HOME`, `OAR_CODEX_AUTH_PATH`

---


## 다른 ADE (Claude Code, Codex, Cursor, Orca, pi, gjc 등)

OAR이 가장 깊게 붙는 곳은 **OMO / Senpi** 입니다. 나머지는 단계가 다릅니다.

| 단계 | ADE | OAR 역할 |
|------|-----|----------|
| 1순위 | OMO, Senpi | 핫스왑, extension, usage, recommend |
| 실험적 | pi, omp, gjc, OpenCode* | `auth.json` 쓰면 `OAR_AUTH_PATH` / `OAR_ACTIVATE_ALL` |
| 부분 | Codex CLI, Argo Grok, Buzz Codex | `oar use` sink — [docs/sinks.md](docs/sinks.md) |
| 별도 | Cursor, Copilot, Orca, Buzz Grok, Gemini CLI, Aider, Cline… | 자체 계정 UI; Buzz Grok은 Cursor 풀 |

\*Senpi형 auth 공유 설정 시

**전체 표·설치 레시피·인기 ADE 메모:**  
→ **[docs/ades.ko.md](docs/ades.ko.md)** · [English](docs/ades.md)

```bash
# 예: 다른 Senpi형 agent dir 지정
export OAR_AUTH_PATH="$HOME/.pi/agent/auth.json"
oar daemon stop; oar daemon start
oar use xai sub
```

## 동작 요약 (중요)

### 핫스왑
병렬 OMO 창은 provider당 **슬롯 1개**를 공유합니다.  
`oar use` 는 **다음 요청**부터 적용 (재시작 없음).

### 0% / 소진 보호
- 원격 usage 0% → **경고 + `oar use` 거절**
- auto failover 는 `QUOTA_EXHAUSTED` **스킵**
- Grok **403 credits** → quota 소진으로 분류
- live `auth.json` 이 어긋나면 resolve 시 **preferred 로 재정렬**

### `oar recommend`
vault 계정을 remaining % + 사용 가능 여부로 정렬한 표.

```text
top pick: openai-codex/main  (100% left)
switch:   oar use openai-codex main
```

**세션 모델은 바꾸지 않습니다.** OAR이 활성화할 **계정** 추천만 합니다.

### 범위
| 함 | 안 함 |
|----|--------|
| 계정 vault + 핫스왑 | 모델 자동 변경 |
| usage % (Codex / Grok) | Orca 자체 계정 UI |
| 선택적 auto 계정 failover | provider 약관 준수 보장 |

---

## macOS 메뉴바 (선택)

```bash
mkdir -p "$HOME/Library/Application Support/SwiftBar"
ln -sf "$(npm root -g)/oar-cli/scripts/oar-xbar.sh" \
  "$HOME/Library/Application Support/SwiftBar/oar.5s.sh"
```

---

## 개발

```bash
bun install
bun test
bun run build
```

npm 배포 메모: [docs/npm-publish.md](docs/npm-publish.md)

---

## 보안·약관

- [SECURITY.md](SECURITY.md)  
- [docs/compliance.md](docs/compliance.md) — 다중 구독 자동 로테이션은 약관 리스크 있음  

---

## 라이선스

[MIT](LICENSE)
