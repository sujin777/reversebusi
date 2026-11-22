reversebusiness (rebiz 0.2.0) 사용 방법
========================================

1. 개요
-------
사업 웹사이트 주소(URL) 하나를 입력하면 공개 페이지를 읽어 사업 구조를 해부하고,
원본의 문구·이미지·이름·코드를 복제하지 않은 중립적인 내 버전 출발점을 만드는 도구입니다.

네 단계 흐름:
  1) 읽기         : robots.txt와 이용약관 확인 후 공개 페이지 최대 5장 수집 (source.json, requests.json, evidence/)
  2) 해부         : 6칸(돈, 흐름, 화면 지도, 기술, 근거와 모르는 것, 내 버전 명세) 채우기 (report.json, report.html)
  3) 내 버전 만들기: 6번 칸 명세와 구역 순서만으로 새 사이트 출발점 생성 (my-version/)
  4) 검사         : 스키마/근거 검사 및 5단어 이상 연속 복사, 브랜드명/도메인/이미지 겹침 검사


2. 현재 설치 상태
-----------------
- 전역 CLI 명령 : rebiz (버전 0.2.0, npm link 연결됨)
- 정밀 모드(REA): rea-agents 6.9.0 설치됨 (겉 읽기 / 흐름 읽기 / 속 읽기 지원)
- 설치된 스킬   :
  * Claude Code       : ~/.claude/skills/reversebusiness
  * Codex / Gemini CLI: ~/.agents/skills/reversebusiness
  * Antigravity       : ~/.gemini/antigravity-cli/skills/reversebusiness


3. AI 코딩 에이전트에서 사용하기 (권장)
---------------------------------------
새 에이전트 세션(Antigravity, Claude Code, Codex, Gemini CLI 등)을 열고 아래처럼 요청합니다.

  reversebusiness 로 https://example.com 를 해부해 줘

옵션 의도 전달 예시:
- 내 사이트일 때          : "reversebusiness 로 https://my-site.com 를 해부해 줘 (내 사이트야)"
- 내 버전 없이 분석만 할 때: "reversebusiness 로 https://example.com 를 해부만 해 줘"
- 특정 사업 주제를 정할 때 : "reversebusiness 로 https://example.com 를 해부하고 'AI 학습 도구' 주제로 내 버전을 만들어 줘"


4. 터미널(CLI)에서 사용하기
---------------------------
4-1. 기본 명령어
  rebiz demo                                      # 번들된 예시 해부 화면 브라우저로 열기
  rebiz <주소>                                    # 공개 페이지 수집 + 해부 + 내 버전 생성 + 화면 열기
  rebiz <주소> --agent claude --yes               # Claude Code CLI로 끝까지 자동 완성
  rebiz <주소> --agent codex --yes                # Codex CLI로 끝까지 자동 완성
  rebiz <주소> --no-fill                          # 수집기와 초안 생성까지만 실행

4-2. 해부 이후 명령어
  rebiz fill report.json [--agent claude|codex]   # 이미 모은 자료만으로 모름 칸 채우기
  rebiz check report.json [--dissect-only]        # 리포트 스키마 및 근거 규칙 검사 (--dissect-only: 해부만 검사)
  rebiz build report.json [--out <폴더>] [--topic "<주제>"] [--force]
                                                  # 6번 칸 명세로 내 버전 출발점 생성 + 겹침 검사
  rebiz apply report.json --to <내 프로젝트 폴더> [--page <파일>] [--url http://localhost:포트] [--agent claude|codex]
                                                  # 내 프로젝트 첫 화면과 비교해 rebiz-apply/plan.md 작성
                                                  # (--agent 지정 시 작업 트리가 깨끗한 git 저장소의 새 브랜치에서 적용, 커밋/배포 없음)
  rebiz view report.json [--mine <내 버전 폴더>] [--out <파일>] [--lang ko|en] [--no-open]
                                                  # 오프라인 단일 HTML 해부 화면(report.html) 생성 및 열기
  rebiz video report.json [--mine <내 버전 폴더>] [--out <파일>] [--lang ko|en]
                                                  # 9:16 (1080x1920) 무음 해부 영상 저장
  rebiz clone-check <내 버전 폴더> --source <source.json>
                                                  # 원본 문구·브랜드명·도메인·이미지 주소 겹침 검사

4-3. 주요 옵션
  --yes, -y         확인 질문 없이 진행
  --dry-run         파일을 내려받거나 바꾸지 않고 계획만 미리 보기
  --lang ko | en    출력 및 해부 화면 언어 지정 (기본: 시스템 로캘 자동 감지)
  --headless        수집용 Chrome 창을 화면에 띄우지 않고 백그라운드 실행
  --no-render       브라우저 렌더링 없이 받은 HTML만 읽기
  --light           REA 정밀 모드를 끄고 가벼운 모드로 읽기
  --no-rea          REA 설치 제안을 건너뛰기
  --own             대상 사이트가 내 소유일 때 지정 (정적 코드 흔적 점검 허용)
  --pages <1~5>     읽을 최대 공개 페이지 수 (기본 5)
  --no-open         완료 후 브라우저 자동 열기 생략
  --remove          reversebusiness가 설치한 스킬만 삭제 (REA는 유지)


5. 해부 화면(report.html) 구성
------------------------------
생성된 report.html은 인터넷 연결 없이 오프라인으로 동작합니다.
- 해부 장면          : 페이지 구역을 attract / value / pay / return 층으로 분해해 시각화
- 돈 흐름도          : 유입 -> 첫 가치 -> 가입 -> 결제 -> 다시 오기 단계와 근거 연결
- 뼈대와 내 버전 비교: 슬라이더로 원본 구역 뼈대와 내 버전(my-version) 나란히 비교
- 9:16 영상 저장     : 화면 내 버튼으로 1080x1920 무음 영상 바로 저장


6. 지켜야 할 선 (주의 사항)
---------------------------
- 로그인, 결제, 유료벽, CAPTCHA, 봇 차단을 우회하지 않으며 가짜 계정을 만들지 않습니다.
- robots.txt와 Crawl-delay를 지키고, 공개 페이지 최대 5장, 요청 간격 2초 이상, GET 전용으로 읽습니다.
- source.json, requests.json, evidence/ 폴더 등 수집 원본 자료는 로컬에만 보관하고 외부에 올리지 않습니다.
- 내 버전의 이름·문구·파일명에 대상 서비스 이름이나 "클론" 표현을 넣지 않습니다.
- 관찰된 사실(observed), 추정(inferred), 코드 흔적(code), 모르는 것(unknown)을 구분해 기록합니다.
