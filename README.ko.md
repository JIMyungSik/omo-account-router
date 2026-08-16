# OAR — OMO Account Router

**언어:** [English](README.md) · [한국어](README.ko.md)

AI 코딩 에이전트(OMO / Senpi 우선)용 **로컬 멀티 계정 핫스왑** 도구입니다.

OAR은 **모델을 고르지 않습니다.** 모델/provider 선택은 에이전트가 합니다.  
OAR은 live auth 슬롯에 **어느 계정을 올릴지** 고릅니다. 대개 **에이전트 재시작 없이** 다음 요청부터 반영됩니다.

```text
사용자  →  omo / senpi  →  모델 요청
                              ↑ 요청마다 getAuth
                         ~/.omo/agent/auth.json   ← provider당 슬롯 1개
                              ↑ 원자적 활성화
oar CLI  ──UDS──  oar-daemon  ──  ~/.oar/vault + state
```

| | |
|--|--|
| 상태 | 초기 공개 / 개인 툴킷 |
| 라이선스 | [MIT](LICENSE) |
| 런타임 | [Bun](https://bun.sh) 1.3+ (`dist/` 는 Node 22+ 가능) |
| 약관 메모 | [docs/compliance.md](docs/compliance.md) (**법률 자문 아님**) |

---

## 왜 쓰나요?

| 불편 | OAR |
|------|-----|
| Grok / Codex / Claude 계정 여러 개, 로그인 반복 | vault에 프로필 여러 개 → `oar use`로 전환 |
| 계정 바꿀 때마다 에이전트 재시작 | auth.json 핫스왑 (Senpi/OMO) |
| “지금 뭐 쓰는 중? 한도 얼마나 남음?” | `oar panel` / `oar usage` 표 |
| 작업 중 한도 | 선택적 `oar auto` failover (**기본 OFF**, 약관 주의) |

---

## 준비물

- macOS 또는 Linux
- [Bun](https://bun.sh) 설치
- OMO / Senpi (또는 같은 방식의 `auth.json`을 읽는 에이전트)
- **본인이 정당하게 소유한** 계정만 (자격증명 공유 금지)

---

## 설치

### A) npm — clone 없이 (권장)

**Node.js 22+** 필요.

> npm 이름 `oar` 는 무관한 옛 패키지(Observable Array)가 선점하고 있습니다.  
> **`oar-cli`** 로 설치하세요. 설치 후 명령어는 그대로 **`oar`** 입니다.

```bash
# npm 레지스트리 (publish 후)
npm install -g oar-cli

# GitHub 아카이브 (publish/로그인 없이 가능)
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```

그다음:

```bash
oar doctor
oar daemon start
oar panel --refresh
```

macOS LaunchAgent + 확장 (선택):

```bash
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build
# GitHub tarball 설치 시 폴더명이 omo-account-router 일 수 있음:
# bash "$(npm root -g)/omo-account-router/scripts/install.sh" --skip-build
```

제거:

```bash
npm uninstall -g oar-cli
# 또는: npm uninstall -g omo-account-router
```

### B) clone + install 스크립트 (Bun 필요)

```bash
git clone https://github.com/JIMyungSik/omo-account-router.git
cd omo-account-router
bash scripts/install.sh --import-auth
```

## 매일 쓰는 방법

### 한눈에 보기

```bash
oar panel --refresh     # 계정 + 로컬 신호 + 원격 잔여 %
oar usage --refresh
oar recommend --refresh  # ranked accounts by remaining %     # Codex 주간/5h + Grok 구독 잔여
oar status              # 간단한 활성 표
```

`oar usage` 예시:

```text
| PROVIDER     | PROFILE | OK  | 5H left | WK left | GROK left | USED | RESET         | SOURCE        |
|--------------|---------|-----|--------:|--------:|----------:|-----:|---------------|--------------|
| openai-codex | main    | yes |       - |      9% |         - |  91% | 08-20 12:37   | codex-wham   |
| xai          | sub     | yes |       - |       - |       97% |   3% | 08-22 10:32   | grok-billing |
```

- **5H** = Codex 짧은(세션) 창이 API에 있을 때만 (없으면 `-`)
- **WK** = Codex 주간 잔여
- **GROK** = xAI **Grok 구독** 크레딧 잔여 (Management API 선불 $ 아님)

### 계정 전환 (OMO 재시작 불필요)

```bash
oar use xai main
oar use xai sub
oar use openai-codex main
```

이미 떠 있는 OMO는 **다음 요청**부터 새 슬롯을 씁니다.  
병렬 OMO 창은 provider당 **전역 슬롯 1개**를 공유합니다 (창마다 다른 계정 아님).

### 지금 로그인된 계정을 vault에 넣기

```bash
# provider 하나
oar import-auth xai main --from ~/.omo/agent/auth.json

# auth.json에 있는 모든 provider
oar import-auth --all
```

### 같은 provider에 2번째 계정 추가

**중요:** `omo` 런처는 항상 `SENPI_CODING_AGENT_DIR=~/.omo/agent` 로 고정합니다.  
격리 로그인에는 **`senpi`** 를 쓰세요.

```bash
# 1) 지금 계정 먼저 vault
oar import-auth xai main

# 2) 임시 폴더에서 B 계정 로그인
export OAR_TMP="$(mktemp -d)/agent"
mkdir -p "$OAR_TMP"
SENPI_CODING_AGENT_DIR="$OAR_TMP" senpi
# TUI: /login → xAI → B 계정으로 OAuth → 종료

# 3) import 후 live는 다시 main
oar import-auth xai sub --from "$OAR_TMP/auth.json"
rm -rf "$(dirname "$OAR_TMP")"
oar use xai main
oar status
```

`omo`만 쓰는 방법 (live 슬롯을 잠깐 덮음):

```bash
oar import-auth xai main
omo
# /logout xai → /login xai (B 계정) → 종료
oar import-auth xai sub
oar use xai main
```

자세한 가이드: `oar guide second-account` · [scripts/second-account.md](scripts/second-account.md)

### 선택: 자동 failover

```bash
oar auto xai on          # 켜기 (기본 OFF — compliance 읽을 것!)
oar auto xai off
```

켜면 `RATE_LIMITED` / `QUOTA_EXHAUSTED` / `AUTH_REVOKED` 등으로 분류된 실패 시  
vault에 있는 다른 프로필을 활성화할 수 있습니다.  
구독 한도를 여러 계정으로 합치는 용도는 provider 약관과 충돌할 수 있습니다. **본인 책임.**

---

## 명령어 한눈에

| 명령 | 설명 |
|------|------|
| `oar status` | 프로필 + 활성 `*` |
| `oar panel [--refresh] [--watch N] [--json] [--xbar]` | 대시보드 |
| `oar usage [provider] [profile] [--refresh]` | 잔여 % 표 |
| `oar accounts [provider]` | JSON 목록 |
| `oar add / remove <provider> <profile>` | 메타 등록/삭제 |
| `oar import-auth <p> <profile> [--from path]` | auth.json → vault |
| `oar import-auth --all [--force]` | 전체 import |
| `oar use <p> <profile>` | 선호 + live 슬롯 활성화 |
| `oar auto <p> on\|off` | auto + failover |
| `oar login <p> <profile>` | 안전한 로그인 절차 안내 |
| `oar logout <p> <profile>` | 폐기 + vault 제거 |
| `oar test <p> <profile> [--live]` | 로컬 헬스 / 선택 라이브 |
| `oar doctor` | 경로·엔진·daemon |
| `oar daemon start\|stop\|status` | 데몬 |
| `oar install` | `scripts/install.sh` |
| `oar guide second-account` | 2계정 가이드 |

환경 변수:

| 변수 | 의미 |
|------|------|
| `OAR_HOME` | 상태 루트 (기본 `~/.oar`) |
| `OAR_SOCK` | 소켓 경로 |
| `OAR_AUTH_PATH` | 쓸 auth.json 하나 |
| `OAR_ACTIVATE_ALL=1` | 발견된 auth.json 모두 기록 |

---

## 핫스왑 원리 (OMO / Senpi)

omo-ai 5.x / senpi 엔진 기준:

1. 런처가 `SENPI_CODING_AGENT_DIR=~/.omo/agent` 설정
2. 모델 호출마다 `getAuth` → `auth.json` 읽기
3. 파일 revision 바뀌면 AuthStorage 재로드
4. OAR은 해당 provider 키만 vault credential로 교체 (다른 provider 유지)

**한계**

- provider당 live 슬롯 1개 (같은 provider 동시 다중 계정 HTTP 불가)
- 일부 provider(오래 붙는 소켓)는 한 요청 더 필요하거나 재연결될 수 있음
- Orca 등 **다른 계정 저장소**를 쓰는 앱은 기본 연동되지 않음

---

## macOS 메뉴바 (선택)

[SwiftBar](https://github.com/swiftbar/SwiftBar) 또는 xbar 설치 후:

```bash
mkdir -p "$HOME/Library/Application Support/SwiftBar"
ln -sf "$PWD/scripts/oar-xbar.sh" \
  "$HOME/Library/Application Support/SwiftBar/oar.5s.sh"
```

5초마다 갱신, 프로필 클릭 시 `oar use`.

---

## 개발

```bash
bun install
bun test
bun run scripts/smoke-hot-switch.ts
bun run build
```

```text
src/           CLI, daemon, router, adapters, usage
tests/         bun test
extensions/    Senpi 확장 (report + /account)
scripts/       install, xbar, 2계정 가이드
docs/          compliance, 설계 메모
```

---

## 보안

- vault·소켓은 제한된 권한
- status/usage에 토큰 원문 출력 금지
- [SECURITY.md](SECURITY.md)

---

## 약관 / 컴플라이언스

다중 구독 + 자동 failover는 provider 약관(한도 우회 등)과 충돌할 수 있습니다.  
[docs/compliance.md](docs/compliance.md)를 읽으세요. **법률 자문이 아닙니다.**

---

## 라이선스

[MIT](LICENSE)
