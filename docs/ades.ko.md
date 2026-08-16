# 다른 ADE에서 OAR 쓰기

**언어:** [English](ades.md) · [한국어](ades.ko.md)

OAR은 **모델 라우터**가 아니라 **계정 레이어**입니다.

| 레이어 | 결정 주체 |
|--------|-----------|
| 어떤 **모델 / provider** 를 호출할지 | ADE (OMO, Claude Code, Codex, …) |
| 그 provider에 **어느 로그인 계정**을 쓸지 | **OAR** (지원하는 auth 저장소를 읽는 경우) |

```text
ADE 세션  →  모델 선택 (예: grok / claude / codex)
                 ↓
            자격증명 필요
                 ↓
OAR vault  →  ADE auth 파일/슬롯에 프로필 1개 활성화
```

---

## 지원 매트릭스

| ADE | 인기 (2025–2026, 대략) | OAR 연동 | 지금 되는 것 |
|-----|------------------------|----------|--------------|
| **OMO** (`omo`) | 니치 (Senpi/OMO) | **1순위 (완전)** | 핫스왑, panel, usage, extension, auto |
| **Senpi** (`senpi`) | 니치 (OMO 엔진) | **1순위** | OMO와 동일, 격리 `/login` 임시 디렉터리 |
| **pi / omp** | OSS CLI 계열 성장 | **실험적** | `auth.json` 형태면 `OAR_AUTH_PATH` 로 가능 |
| **gjc** (gajae-code) | 니치 포크 | **실험적** | Senpi형 `auth.json` 이면 경로 지정 |
| **OpenAI Codex CLI** | 높음 | **부분** | usage/recommend, vault; CLI 핫스왑은 `CODEX_HOME` 브리지 필요 |
| **Claude Code** | **매우 높음** (설문 상위) | **부분 / 예정** | `~/.claude` 별도 포맷 — 아직 1순위 아님 |
| **Cursor** | **매우 높음** (IDE) | **별도** | 자체 로그인 UI, OAR 비제어 |
| **GitHub Copilot** | **매우 높음** | **없음** | VS Code/GitHub 인증 |
| **OpenCode** | OSS 관심 높음 | **실험적** | 공유 auth 설정 시에만 |
| **Gemini CLI** | 상승 중 | **없음 / TBD** | Google 인증 별도 |
| **Aider** | 기존 OSS | **없음 / TBD** | 환경변수 API 키 등 |
| **Orca** | 니치 데스크톱 | **없음 (자체 멀티계정)** | Application Support 아래 자체 프로필 |
| **Cline / Continue / Windsurf** | IDE 확장 인기 | **없음** | 각자 시크릿 저장 |

**인기 참고 (단일 ‘점유율’ 수치는 없음, 방향만):**

- 개발자 설문·툴링 정리에서 **Claude Code**, **Cursor**, **Copilot** 이 일상 사용 상위에 자주 등장 ([Pragmatic Engineer – AI tooling 2026](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026) 등).
- **OpenAI Codex CLI** 는 OpenAI 생태계에서 널리 사용.
- **OpenCode**, **Gemini CLI**, **Aider** 는 OSS/CLI 쪽에서 존재감.
- **OMO / Senpi / pi / gjc / Orca** 는 특정 커뮤니티에서 중요하지만 전 세계 다수는 아님.

OAR이 **가장 깊게** 붙는 곳은 **Senpi/OMO `auth.json` 핫 리로드** 경로입니다. 다른 ADE는 **어댑터**(경로 + 포맷 + 리로드)가 필요합니다.

---

## 1순위: OMO / Senpi

### 설치

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
# 또는: npm install -g oar-cli

oar doctor
oar daemon start
oar import-auth --all
bash "$(npm root -g)/oar-cli/scripts/install.sh" --skip-build   # 선택
```

### 일상

```bash
oar panel --refresh
oar recommend --refresh
oar use xai sub
oar use openai-codex main
```

### 재시작 없이 바뀌는 이유

1. `omo` → `SENPI_CODING_AGENT_DIR=~/.omo/agent`
2. 모델 호출마다 `auth.json` 재읽기
3. OAR이 provider 키 하나만 원자적으로 교체

### 2번째 계정 로그인

**`omo` 말고 `senpi` + 임시 디렉터리** (`omo` 런처는 agent dir 고정).

```bash
oar guide second-account
```

---

## 실험적: pi / omp / gjc (Senpi형)

### 1) auth 파일 찾기

```bash
ls ~/.omo/agent/auth.json
ls ~/.senpi/agent/auth.json
ls ~/.pi/agent/auth.json
ls ~/.omp/agent/auth.json
ls ~/.gajae-code/agent/auth.json
```

### 2) OAR이 그 파일을 쓰게

```bash
export OAR_AUTH_PATH="$HOME/.pi/agent/auth.json"
# 또는 발견된 경로 전부
export OAR_ACTIVATE_ALL=1

oar daemon stop; oar daemon start
oar use xai sub
```

### 3) 리로드 방식

| ADE 동작 | 결과 |
|----------|------|
| 요청마다 auth 재읽기 | OMO처럼 핫스왑 |
| 시작 시 한 번만 캐시 | `oar use` 후 **재시작** 필요 (콜드 스왑) |

### 4) extension / auto

`extensions/oar-senpi.js` 는 **Senpi/OMO용**.  
pi/gjc는 훅이 없으면 **수동 `oar use` + usage/recommend** 만 쓰면 됩니다.

---

## 부분 지원: OpenAI Codex CLI

| 기능 | 상태 |
|------|------|
| `openai-codex` usage / recommend | 가능 |
| vault 다중 계정 | 가능 |
| 실행 중 `codex` TUI 핫스왑 | **경우 따라** — 기본은 `~/.codex` / `CODEX_HOME` |

**실무**

```bash
oar recommend openai-codex --refresh
```

Codex CLI에 vault를 직접 물리려면 `CODEX_HOME` 동기화 스크립트/어댑터가 더 필요합니다 (예정).

---

## 부분 지원: Claude Code

전 세계적으로 사용량이 매우 큼.

| 기능 | 상태 |
|------|------|
| OAR 1순위 핫스왑 | **아직 아님** |
| 자격증명 | `~/.claude/` (Senpi `auth.json` 과 다름) |
| 커뮤니티 멀티계정 | claude-swap, TeamClaude, `CLAUDE_CONFIG_DIR` 등 |

지금은 OMO용 xai/codex 계정에 OAR을 쓰고, Claude Code 멀티계정은 **전용 툴**을 쓰거나 Claude 어댑터를 기다리는 구성이 맞습니다.

---

## 미연동: Cursor, Copilot, Gemini CLI, Aider, IDE 확장

각자 로그인/시크릿 UI를 가집니다.  
OAR vault에 넣은 provider의 **usage 모니터** 정도만 공통으로 쓸 수 있고, `oar use` 한 번으로 전부 바뀌진 않습니다.

---

## 미연동: Orca

Orca는 자체 멀티계정 (예: `~/Library/Application Support/orca/codex-accounts/...`).

| 목적 | 도구 |
|------|------|
| Orca 세션 계정 | Orca UI |
| OMO/Senpi 계정 | OAR |
| 둘 다 한 방에 | 향후 어댑터 / 수동 export |

---

## 환경 변수 (공통)

| 변수 | 의미 |
|------|------|
| `OAR_HOME` | vault/state (기본 `~/.oar`) |
| `OAR_SOCK` | 데몬 소켓 |
| `OAR_AUTH_PATH` | 활성화할 auth.json 하나 |
| `OAR_ACTIVATE_ALL=1` | 발견된 auth.json 모두에 기록 |

---

## ADE 유형별 기능

| 기능 | OMO/Senpi | pi/gjc | Codex CLI | Claude Code | Orca | Cursor/Copilot |
|------|-----------|--------|-----------|-------------|------|----------------|
| panel / usage / recommend | 예 | 예* | 예* | 제한 | 모니터* | vault 있을 때만 |
| 핫 `oar use` | 예 | 리로드 시 | 부분 | 아니오 | 아니오 | 아니오 |
| extension auto | 예 | 아니오 | 아니오 | 아니오 | 아니오 | 아니오 |

\*usage/recommend 는 다른 ADE가 아니라 **OAR vault** 에 자격증명이 있어야 합니다.

---

## 추천 구성

### OMO 중심
OAR 풀세트 (extension, recommend, auto는 compliance 읽고).

### Claude Code + Codex + 가끔 OMO
- OAR: OMO + Codex/Grok vault·usage  
- Claude: 전용 멀티계정 툴  
- 한 번의 `oar use`가 모든 ADE를 바꾸길 기대하지 말 것  

### Orca 중심
Orca UI로 Orca 계정, OMO 쓸 때만 OAR.

### 잔여 %만 보고 싶을 때
```bash
oar import-auth --all
oar usage --refresh
oar recommend --refresh
```

---

## 어댑터 로드맵 (인기 + 기술 적합도)

1. OMO/Senpi — 완료  
2. Codex CLI `CODEX_HOME` activate  
3. Claude Code profile 어댑터  
4. pi/omp/gjc auth.json 자동 감지  
5. Orca 브리지  

---

## 진단

```bash
oar doctor
echo "OAR_AUTH_PATH=$OAR_AUTH_PATH"
ls -la ~/.omo/agent/auth.json ~/.senpi/agent/auth.json ~/.codex/auth.json 2>/dev/null
```

`oar use` 는 됐는데 ADE가 예전 계정이면:

1. ADE가 OAR이 쓴 **같은 파일**을 읽는지  
2. 캐시형이면 ADE **재시작**  
3. Claude/Orca/Cursor 쓰면서 OMO 경로만 바꾼 건 아닌지  

---

## 같이 보기

- [README.ko.md](../README.ko.md)  
- [compliance.md](compliance.md)  
- `oar guide second-account`  
