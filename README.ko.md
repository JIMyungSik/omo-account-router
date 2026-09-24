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
| 버전 | `0.2.0` |
| 라이선스 | [MIT](LICENSE) |
| 런타임 | Node.js **22+** (개발 시 Bun 선택) |
| 테스트 | `bun test` |
| 약관 메모 | [docs/compliance.md](docs/compliance.md) (**법률 자문 아님**) |
| 저장소 | https://github.com/JIMyungSik/omo-account-router |

> npm 이름 `oar` 는 무관한 옛 패키지가 선점 중입니다. **`oar-cli`** 로 설치하고, 명령은 **`oar`** 를 쓰세요.

**OMO `5.0.0-0.beta.42` / Senpi `2026.9.4-3`** 기준: `after_provider_response`는 status+headers만 오므로 헤더에서 `invalid_grant`를 읽고, live `auth.json` 기록은 native `accounts` 필드를 덮어쓰지 않습니다.

## 플랫폼

CLI, 데몬, vault는 macOS, Linux, Windows에서 동작합니다. 2026-09-24, Bun 1.3.14 기준:

| OS | 방법 | 결과 |
|----|------|------|
| Linux arm64 | Docker `oven/bun:1.3.14`, `bun test` | 51 pass, 3 skip, 0 fail |
| Ubuntu | GitHub `ubuntu-latest`, `bun test` + style | pass ([run 35945289044](https://github.com/JIMyungSik/omo-account-router/actions/runs/35945289044)) |
| Windows | GitHub `windows-latest`, 같은 명령 | pass (같은 run) |

`scripts/install.sh`와 LaunchAgent는 macOS 전용입니다. Linux/Windows는 Bun 또는 Node 22로 빌드한 뒤 `oar daemon start`로 때웁니다. Argo 시크릿 기본 경로는 `~/Library/Application Support` 아래이므로, 다른 OS에서는 파일이 있으면 `OAR_ARGO_SECRETS_PATH`를 지정합니다.

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
oar                         # status + 원격 잔여 한도 즉시 조회
oar status
oar panel --refresh         # 표: 활성 슬롯 + 로컬 신호 + 원격 %
oar usage                   # Codex 5h/주간 + Grok 구독 잔여 즉시 조회
oar recommend --refresh     # 다음에 쓸 계정 순위 표

# 구독료 절감 감사 (월 $ 수동 입력 + usage 휴리스틱)
oar subscriptions set xai main --monthly-usd 30 --plan "SuperGrok"
oar subscriptions audit --refresh

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

### auth 항목 하나에 숨은 로그인들 (xAI 멀티 로그인)

xAI는 Google + Sign-in-with-Apple 등 여러 로그인을 한 provider 슬롯의
`accounts[]` 배열에 넣을 수 있습니다. OAR은 기본으로 **primary**(최상위)
토큰만 읽으므로, 살아있는 보조 로그인이 소진된 것처럼 보일 수 있습니다.
임포트 시 계정을 명시적으로 고르세요:

```bash
# 안에 뭐가 있는지 (1=default, 2=login-2, ...)
oar import-auth xai apple --account 3          # 1-based 인덱스로
oar import-auth xai apple --account login-3    # 또는 name으로
oar usage xai apple --refresh && oar use xai apple
```

## Argo · Buzz에 붙이기

OAR을 복제하지 않습니다. vault는 하나이고, `oar use`가 OMO `auth.json` 외에 **이미 있는** Argo/Codex 파일만 이중기록합니다. 설계: [docs/sinks.md](docs/sinks.md)

| 표면 | 프로바이더 | Sink | 비고 |
|------|------------|------|------|
| Argo Grok | `xai` | `argo-grok` | `runners.grok`만 |
| Argo host Codex | `openai-codex` | `codex-home` | Argo `runners.codex.type = host`는 호스트 Codex를 읽음 |
| Buzz Codex | `openai-codex` | `codex-home` | 기본 `~/.codex/auth.json` |
| Buzz Grok | — | **제외** | `runtime: cursor` / Cursor 풀. OAR xAI 슬롯 아님 |

전제:

1. `oar daemon start` (LaunchAgent면 이미 켜져 있음 → `oar doctor`)
2. 쓸 계정이 vault에 있음 (`oar import-auth` / `oar status`)
3. **대상 파일이 이미 있어야 합니다.** Argo/Codex에 한 번은 직접 로그인하세요. OAR은 설치 파일을 만들지 않습니다.

`oar use`는 sink마다 `id` / `status` / `path` / `detail`을 출력합니다(자격 증명 없음). sink가 skip/error여도 OMO 활성화는 성공합니다(`wrote` / `skipped` / `error`).

### Argo (Grok / xAI)

Argo Grok runner는 Senpi `auth.json`이 아니라 이런 JSON입니다.

`~/Library/Application Support/com.beyondworks.argo/workspaces/.account-secrets-local.json`  
워크스페이스 `…/workspaces/<id>/.secrets.json`

```json
{
  "runners": {
    "grok": {
      "type": "oauth",
      "value": "{\"access_token\":\"…\",\"refresh_token\":\"…\",\"expires_at\":1700000000000}"
    },
    "codex": { "type": "host", "value": "auto" }
  }
}
```

`expires_at`은 밀리초입니다. 형제 runner(`codex`, `glm` 등)는 그대로 둡니다.

```bash
oar import-auth xai main
# 두 번째 계정이면 oar guide second-account 후:
# oar import-auth xai sub --from "$OAR_TMP/auth.json"

oar status          # xai/main, xai/sub 보이는지
oar use xai sub
# 기대: sink: argo-grok wrote <path>
# Argo가 시작 시 시크릿을 캐시하면 앱을 한 번 재시작
```

끄기: `OAR_ARGO_SINK=0` 또는 `OAR_SINKS=0` 후 daemon 재시작.

Argo **Codex**는 `type: host`라 호스트 Codex(`~/.codex`)를 씁니다. 아래 Buzz Codex와 같은 sink입니다. Argo/Buzz가 OAR auto-failover를 돌리지 않습니다. 실패 보고는 OMO extension만 합니다.

### Buzz / 호스트 Codex (`openai-codex`)

이 머신에서 Buzz Codex 에이전트는 `runtime: codex` / `codex-acp`이고 `CODEX_HOME`을 안 넣습니다. 호스트 CLI 홈인 **`~/.codex/auth.json`** 을 읽습니다.

네이티브 Codex `auth.json`에는 `tokens.id_token`이 있어야 합니다. 예전 Senpi-only vault(access/refresh만)는 대상 Codex 파일이 **같은 계정**(access+refresh가 일치)이면 그 파일의 ID 토큰을 재사용할 수 있습니다. 그렇지 않으면 `oar use`는 `sink: codex-home error missing_id_token`을 찍고 파일을 그대로 두며, 아래처럼 네이티브 Codex 로그인에서 다시 import해야 합니다.

**메인 (현재 호스트 Codex, 파일 저장):**

```bash
mkdir -p "$HOME/.codex"
grep -q 'cli_auth_credentials_store *= *"file"' "$HOME/.codex/config.toml" 2>/dev/null \
  || printf 'cli_auth_credentials_store = "file"\n' >> "$HOME/.codex/config.toml"
codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex main --from "$HOME/.codex/auth.json"
# idToken이 이미 있는 Senpi 슬롯이면:
# oar import-auth openai-codex main
```

**서브 (격리 로그인 홈 — `CODEX_HOME`을 export 하지 마세요):**

```bash
OAR_CODEX_LOGIN=$(mktemp -d)
CODEX_HOME="$OAR_CODEX_LOGIN" codex -c 'cli_auth_credentials_store="file"' login
oar import-auth openai-codex sub --from "$OAR_CODEX_LOGIN/auth.json"
rm -rf "$OAR_CODEX_LOGIN"
# 지우는 것은 임시 로그인 디렉터리뿐입니다. daemon 대상은 바뀌지 않습니다.
# 이후 daemon은 기존 호스트 Codex(~/.codex)에 씁니다. 바꾸려면 아래 OAR_CODEX_* 를
# 그 daemon 프로세스에 넣으세요.
oar use openai-codex sub
# Buzz Codex 다음 턴 또는 Codex CLI 새 세션. 캐시되면 앱 재시작
```

Buzz가 따로 `CODEX_HOME`을 쓰면 **daemon 프로세스**가 `OAR_CODEX_HOME` 또는 `OAR_CODEX_AUTH_PATH`를 봐야 합니다. 셸 `export`는 LaunchAgent에 전달되지 않습니다.

**LaunchAgent** (`~/Library/LaunchAgents/com.victor.oar-daemon.plist`)는 plist의 `EnvironmentVariables`만 봅니다(`HOME`, `PATH`, `OAR_HOME`이 기본). 그 plist를 고친 뒤 다시 로드하세요.

```bash
PLIST="$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
# EnvironmentVariables 아래에 OAR_CODEX_HOME 그리고/또는 OAR_CODEX_AUTH_PATH 를 넣은 다음:
launchctl unload "$PLIST"
launchctl load -w "$PLIST"
# 최신 동등 명령:
# launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"
# launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

**셸에서 띄우는 daemon:** 먼저 LaunchAgent를 unload/bootout 하세요. KeepAlive가 에이전트를 다시 켜면 셸 프로세스와 경합합니다.

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.victor.oar-daemon.plist"
# 또는: launchctl bootout "gui/$(id -u)/com.victor.oar-daemon"

export OAR_CODEX_HOME=/path/to/that/home
# 또는: export OAR_CODEX_AUTH_PATH=/path/to/that/home/auth.json
oar daemon stop
oar daemon status   # down / not running 인지 확인
oar daemon start
oar use openai-codex sub
```

`oar daemon stop; oar daemon start`를 동기 재시작으로 쓰지 마세요.

daemon Codex 경로 우선순위: **`OAR_CODEX_AUTH_PATH` > `OAR_CODEX_HOME` > `CODEX_HOME` > `~/.codex`**.

| 변수 | 역할 |
|------|------|
| `OAR_SINKS=0` | Argo+Codex sink 전부 끔 |
| `OAR_ARGO_SINK=0` | Argo만 끔 |
| `OAR_CODEX_SINK=0` | Codex 홈만 끔 |
| `OAR_ARGO_SECRETS_PATH` | Argo secrets JSON 한 파일 |
| `OAR_CODEX_AUTH_PATH` | Codex `auth.json` 직접 지정 |
| `OAR_CODEX_HOME` | `auth.json` 부모 (daemon이 보는 값) |
| `CODEX_HOME` | 동일. daemon 프로세스가 볼 때만 |

### sink 출력 / 문제 해결

```text
sink: argo-grok wrote /…/.secrets.json
sink: codex-home skipped no_codex_auth
sink: codex-home error missing_id_token
sink: argo-grok error …/bad.json: invalid_json
```

| detail | 의미 |
|--------|------|
| `wrote` | 대상 파일을 갱신함 |
| `skipped` + `no_codex_auth` / `no_argo_secrets` | 파일 없음 — 앱에 한 번 로그인 |
| `skipped` + `unchanged` | 같은 Codex 토큰이 이미 디스크에 있음 |
| `error` + `missing_id_token` | 네이티브 Codex `auth.json`을 다시 import (토큰을 만들지 말 것) |
| `error` + `invalid_json` | 대상 파일은 한 바이트도 안 바뀜 |

sink 쓰기가 실패해도 OMO `auth.json`은 롤백하지 않습니다. 없는 파일은 skip합니다. `touch`로 빈 파일을 만들지 마세요. 자격 증명을 캐시하는 앱은 `oar use` 후 재시작하거나 새 세션을 여세요. 픽스처/스모크는 실제 GUI 로그인이나 유료 모델 요청을 검증하지 않습니다.

---

## 명령어

| 명령 | 설명 |
|------|------|
| `oar` | status + 원격 잔여 한도 즉시 조회 |
| `oar status` | 프로필 + 활성 `*` (원격 한도 조회 안 함) |
| `oar panel [--refresh] [--watch N] [--json] [--xbar]` | 대시보드 표 |
| `oar usage [provider] [profile] [--refresh]` | 원격 잔여 % 조회 및 표시 |
| `oar recommend [--refresh] [--json] [provider...]` | 잔여 % 기준 순위 표 |
| `oar subscriptions list` | 설정된 월 구독료 |
| `oar subscriptions set <p> <profile> --monthly-usd <n>` | 월 비용 기록 |
| `oar subscriptions audit [--json] [--refresh]` | 유지/해지 후보 + 절감액 |
| `oar accounts [provider]` | JSON 목록 |
| `oar import-auth <p> <profile> [--account latest\|primary\|<slot>]` | vault 적재. 기본은 방금 추가된 `login-N`. 추가 인자가 있으면 그 슬롯 |
| `oar who` | 각 live auth.json에 실제로 들어 있는 vault 프로필 |
| `oar use <p> <profile> [--force]` | 전환. 있는 로컬 auth.json과 Codex 키 두 개를 같이 씀 |
| `oar remove <p> <profile>` | 그 프로필 삭제. 같은 계정의 live 슬롯도 삭제 |
| `oar remove *` | vault 계정 전부 삭제 |
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
# 예: 다른 Senpi형 agent dir 지정 (셸 daemon)
export OAR_AUTH_PATH="$HOME/.pi/agent/auth.json"
oar daemon stop
oar daemon status   # down / not running 인지 확인
oar daemon start
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
bun run scripts/smoke-hot-switch.ts
bun run scripts/smoke-sinks.ts
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
