# 두 번째 계정 로그인 가이드 / Second Account Login Guide for OAR

OAR은 계정 로그인을 자동화하지 않습니다. 브라우저 OAuth / device-code 로그인은 사람이 직접 합니다. OAR은 **로그인 후** 자격증명을 vault에 넣고 `oar use`로 live `auth.json` 슬롯을 바꿉니다.

OAR does not automate provider login. A human completes browser OAuth / device-code. OAR only vaults the result and hot-switches the live slot.

## 치명적 주의 / Critical warning

**`omo` 런처는 항상 `SENPI_CODING_AGENT_DIR=~/.omo/agent` 로 덮어씁니다.**
환경변수로 임시 디렉터리를 줘도 `omo` 로는 격리 로그인이 되지 않습니다.

**The `omo` launcher always forces `SENPI_CODING_AGENT_DIR=~/.omo/agent`.**
You cannot isolate a second login by exporting env vars and running `omo`.

또한 `omo auth login` 같은 서브커맨드는 없습니다. 로그인은 TUI 안에서 **`/login`** 입니다.
There is no `omo auth login` CLI. Login is the in-TUI **`/login`** command.

## Method A — 격리 senpi 디렉터리 (권장) / Isolated senpi dir (recommended)

`senpi` 바이너리는 `omo` 런처를 거치지 않으므로 `SENPI_CODING_AGENT_DIR` 이 그대로 먹습니다.

### 1. 현재(첫) 계정을 먼저 vault에 넣기

```bash
# daemon running: oar daemon start
oar import-auth xai main --from ~/.omo/agent/auth.json
# or all providers at once:
# oar import-auth --all
```

### 2. 임시 agent 디렉터리

```bash
export OAR_TMP_LOGIN_DIR="$(mktemp -d)/agent"
mkdir -p "$OAR_TMP_LOGIN_DIR"
```

### 3. senpi로 두 번째 계정 로그인

```bash
SENPI_CODING_AGENT_DIR="$OAR_TMP_LOGIN_DIR" senpi
```

TUI에서:

1. `/login` 입력
2. provider 선택 (예: xAI / Grok)
3. 브라우저·device code 창에서 **두 번째 계정**으로 로그인
4. 성공 확인 후 TUI 종료

### 4. vault로 import

```bash
oar import-auth xai account-b --from "$OAR_TMP_LOGIN_DIR/auth.json"
```

### 5. 임시 디렉터리 삭제

```bash
rm -rf "$(dirname "$OAR_TMP_LOGIN_DIR")"
```

토큰은 이미 `~/.oar/vault` (mode 0600) 에 있습니다.

### 6. 전환

```bash
oar use xai account-b
oar status          # ★ = active
oar test xai account-b
# optional network probe (does not change routing state):
oar test xai account-b --live
```

실행 중 OMO 세션은 **재시작 없이** 다음 요청부터 새 슬롯을 읽습니다.

## Method B — live 슬롯 임시 교체 / Temporary live swap

`senpi` 를 쓰기 어렵거나 Method A가 실패할 때.

```bash
oar import-auth xai main
omo
# TUI:
#   /logout  → xai
#   /login   → xai  (SECOND account)
# exit TUI
oar import-auth xai account-b
oar use xai main          # put first account back into the live slot
oar use xai account-b     # when you actually want B
```

`/logout` ~ `/login` 사이에는 live xAI 슬롯이 비거나 B만 있으므로, 그 구간 동안 Grok 호출은 실패할 수 있습니다.

## 같은 provider 동시 다중 계정? / Concurrent multi-account?

**불가 (설계 한계).** Senpi `auth.json` 은 provider당 슬롯 1개입니다.
OAR은 “어느 계정을 그 슬롯에 올릴지” 를 바꿉니다. 한 프로세스에서 같은 provider의 A+B 를 동시 HTTP로 쓰는 구조가 아닙니다.

## 요약 / Summary

| 단계 | 명령 |
|---|---|
| 첫 계정 vault | `oar import-auth <p> main` |
| 격리 로그인 | `SENPI_CODING_AGENT_DIR=$TMP senpi` → `/login` |
| 두 번째 vault | `oar import-auth <p> account-b --from $TMP/auth.json` |
| 전환 | `oar use <p> account-b` |
| 확인 | `oar status` |

CLI 단축: `oar guide second-account`
