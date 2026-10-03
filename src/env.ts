export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** 보고서 제출 파일 저장소: R2(FILES_R2) 를 우선 쓰고, 없으면 KV(FILES, 값당 25 MiB) */
  FILES_R2?: R2Bucket;
  FILES?: KVNamespace;
  APP_NAME: string;
  ORG_NAME: string;
  ORG_SUB: string;
  ORG_MARK: string;
  APP_TZ: string;
  /** 최초 관리자(부트스트랩) 토큰. DB 에 관리자를 만든 뒤 제거 가능. */
  ADMIN_TOKEN?: string;
  /** 공개 발급 신청 허용 여부 ("false" 면 신청 페이지 비활성) */
  SIGNUP_ENABLED?: string;
  /** 설정 시 신청 폼에 이 코드를 입력해야 함 (스팸 방지, secret 권장) */
  SIGNUP_CODE?: string;
  /** 토큰 재발급: "false" 면 관리자 승인 후 수령, 그 외(기본)는 이름+이메일 일치 시 즉시 발급 */
  REISSUE_AUTO?: string;
  /** 핀 열람 세션 만료일 (YYYY-MM-DD, APP_TZ 기준 그날 자정까지). 비우거나 지난 날짜면 24시간 세션 */
  VIEWER_SESSION_UNTIL?: string;
}

export type GlobalRole = "admin" | "member";
export type CategoryRole = "lead" | "member" | "evaluator";

export interface User {
  id: string;
  name: string;
  email: string;
  role: GlobalRole;
  note: string;
  created_at: string;
  disabled_at: string | null;
  last_seen_at: string | null;
}

export interface Membership {
  category_id: string;
  category_name: string;
  /** viewer = 핀 열람 세션(읽기 전용, 구성원 아님) */
  role: CategoryRole | "viewer";
  /** 카테고리 트랙 (paper | capstone) */
  track?: string;
}

/** 핀 열람 세션 (공개 카테고리를 토큰 없이 읽기 전용으로 보는 접근) */
export interface ViewerInfo {
  session_id: string;
  category_id: string;
  category_name: string;
  expires_at: string;
}

export interface AuthContext {
  user: User;
  memberships: Membership[];
  tokenId: string | null; // null = ADMIN_TOKEN 부트스트랩 또는 열람 세션
  isAdmin: boolean;
  source: "web" | "mcp" | "api";
  /** 설정되어 있으면 읽기 전용 열람 모드 (쓰기 API·도구 전부 거부) */
  viewer?: ViewerInfo;
}

// ---------- 트랙 (카테고리 유형) 과 단계 ----------
// 논문(paper): 기획 → 리서치 → 관련기법 → 실험결과 → 논문작성 → 검토·투고
// 캡스톤(capstone): 주제·문제 발견 → 시장·사업모델 → MVP 빌드·배포 → 피드백·개선 → 사업성·최종보고 → 최종 발표
// 단계 id 는 트랙을 통틀어 유일하다 (프로젝트는 카테고리의 트랙을 물려받는다).

export interface StageDef {
  id: string;
  label: string;
  hint: string;
  /** 산출물·마일스톤 안내 (캡스톤 등) */
  milestone?: string;
}

export interface RubricAxis {
  id: string;
  label: string;
  max: number;
  hint?: string;
  /** 선택형 문항: 이 점수들 중 하나만 고를 수 있다 (예: 우수 10 · 중간 7 · 미흡 4) */
  choices?: { score: number; label: string }[];
}

/** 보고서 제출 마일스톤 (캡스톤): 주차 기준 기본 마감, 카테고리에서 날짜로 덮어쓸 수 있다 */
export interface ReportDef {
  id: string;
  label: string;
  /** 기본 마감 주차 (해당 주차의 마감 요일 자정) */
  week: number;
  /** 평가가 귀속되는 단계 */
  stage: string;
  hint?: string;
  /** 이 마일스톤 전용 평가 기준 (모든 문항 필수). 없으면 트랙 루브릭 */
  rubric?: RubricAxis[];
  /** 종합 점수 가중치 기본값(%) — 카테고리 milestone_weight 로 덮어쓸 수 있다 */
  weight?: number;
}

export interface TrackDef {
  id: string;
  label: string;
  /** 프로젝트 단위를 부르는 말 (논문 / 프로젝트) */
  noun: string;
  description: string;
  stages: StageDef[];
  /** 평가 루브릭 (평가자가 마일스톤마다 점수를 매기는 축) */
  rubric: RubricAxis[];
  /** 보고서 제출 마일스톤 (없으면 제출 기능 꺼짐) */
  reports?: ReportDef[];
}

export const TRACKS: Record<string, TrackDef> = {
  paper: {
    id: "paper",
    label: "논문",
    noun: "논문",
    description: "연구 논문 흐름. 기획 → 리서치 → 관련기법 → 실험결과 → 논문작성 → 검토·투고",
    stages: [
      { id: "planning", label: "기획", hint: "연구 질문·가설·기여점·범위" },
      { id: "literature", label: "리서치", hint: "선행연구·문헌 정리·차별점" },
      { id: "method", label: "관련기법", hint: "적용 기법·모델·실험 설계" },
      { id: "experiment", label: "실험결과", hint: "데이터·실험 결과·분석" },
      { id: "writing", label: "논문작성", hint: "초고·그림·표·구성" },
      { id: "review", label: "검토·투고", hint: "내부 검토·수정·투고·리뷰 대응" },
    ],
    rubric: [
      { id: "problem", label: "문제 정의·기여", max: 25, hint: "연구 질문의 명확성과 기여점의 새로움" },
      { id: "method", label: "방법 타당성", max: 25, hint: "기법 선택·실험 설계의 적절성" },
      { id: "evidence", label: "실험·근거", max: 25, hint: "결과의 충분성·재현성·해석" },
      { id: "writing", label: "글쓰기·완성도", max: 25, hint: "구성·그림·표·문장" },
    ],
  },
  capstone: {
    id: "capstone",
    label: "캡스톤",
    noun: "프로젝트",
    description: "한 학기 팀 서비스 개발. 가설→빌드→배포→피드백→학습 루프를 3~4회 돌며 마일스톤(보고서 3회·발표 3회)을 채운다",
    stages: [
      { id: "topic", label: "주제·문제 발견", hint: "문제·목표 고객·검증할 가설 정의, 주제 선정 기준(2축) 검토", milestone: "2주차 온라인 주제 발표 (루프 0)" },
      { id: "market", label: "시장·사업모델", hint: "고객 니즈 조사, TAM-SAM-SOM 추정, 린 캔버스 v1(검증할 가설 목록), 첫 프로토타입 계획", milestone: "4주차 1차 보고서" },
      { id: "mvp", label: "MVP 빌드·배포", hint: "MVP 범위 좁히기, AI 도구로 구현, 실제 배포 URL 확보 (루프 1~2)", milestone: "배포된 MVP URL" },
      { id: "feedback", label: "피드백·개선", hint: "지표·사용자 테스트로 피드백 측정, 회고, 린 캔버스 v2 갱신, 다음 가설 (루프 2~3)", milestone: "8주차 2차 보고서(중간) · 9주차 데모 발표" },
      { id: "business", label: "사업성·최종보고", hint: "루프별 기록 정리, 3년 손익·사업성 분석, 최종보고서 작성 (A4 20쪽 이내, 지정 목차)", milestone: "12주차 최종보고서" },
      { id: "final", label: "최종 발표", hint: "발표 자료·시연 준비, Q&A 대응 (발표자 랜덤 선정이므로 전원 준비)", milestone: "기말 최종 발표" },
    ],
    reports: [
      // 평가 기준: GBT 캡스톤 심사 문항(2025 구글폼 평가지와 동일). 문항당 10·7·4점 선택, 모든 문항 필수.
      { id: "report1", label: "1차 보고서", week: 4, stage: "market", hint: "주제·시장·사업모델, 린 캔버스 v1", weight: 20, rubric: [
        { id: "topic_fit", label: "주제 적합성", max: 10, hint: "GBT학부 졸업 자격을 판단하기에 적합한 주제입니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
        { id: "problem_goal", label: "문제·목표 제시", max: 10, hint: "해결하고자 하는 문제점을 분명히 제시하고 있으며, 과제의 달성 목표가 분명합니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
        { id: "report_format", label: "보고서 작성기준", max: 10, hint: "보고서 작성기준을 잘 지키고 있습니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
      ] },
      { id: "report2", label: "2차 보고서(중간)", week: 8, stage: "feedback", hint: "MVP 배포·피드백 루프·회고", weight: 30, rubric: [
        { id: "improvement", label: "1차 대비 개선도", max: 10, hint: "1차 평가와 비교해서 주제적합성, 문제점분석 및 목표제시, 보고서작성준수 측면에서 얼마나 개선되었습니까?", choices: [{ score: 10, label: "20% 이상 개선" }, { score: 7, label: "20% 이내 개선" }, { score: 4, label: "동일" }] },
        { id: "goal_process", label: "목표 도출 과정", max: 10, hint: "목표 도출 과정이 얼마나 체계적이고 합리적입니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
        { id: "goal_plan", label: "목표 달성 방안", max: 10, hint: "목표 달성 방안이 얼마나 구체적이고 현실적입니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
      ] },
      { id: "final", label: "최종보고서", week: 12, stage: "business", hint: "A4 20쪽 이내, 지정 목차", weight: 50, rubric: [
        { id: "improvement", label: "2차 대비 개선도", max: 10, hint: "2차 평가와 비교해서 주제적합성, 문제점분석 및 목표제시, 보고서작성준수 측면에서 얼마나 개선되었습니까?", choices: [{ score: 10, label: "20% 이상 개선" }, { score: 7, label: "20% 이내 개선" }, { score: 4, label: "동일" }] },
        { id: "performance", label: "계획 대비 성과", max: 10, hint: "계획 대비 성과를 어느 정도 달성하였습니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
        { id: "achievement", label: "실제 달성 수준", max: 10, hint: "목표 달성율 대비 실제 달성 수준", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
        { id: "teamwork", label: "팀원 간 협력", max: 10, hint: "팀원 간 협력이 프로젝트 진행에 잘 반영되었습니까?", choices: [{ score: 10, label: "우수" }, { score: 7, label: "중간" }, { score: 4, label: "미흡" }] },
      ] },
    ],
    rubric: [
      { id: "improvement", label: "직전 대비 개선도", max: 30, hint: "이전 루프·보고서 대비 무엇이 나아졌나" },
      { id: "achievement", label: "목표 대비 달성률", max: 30, hint: "스스로 세운 목표를 얼마나 달성했나" },
      { id: "records", label: "기록 충실도", max: 20, hint: "매주 진행 기록·루프 기록의 성실성" },
      { id: "viability", label: "완성도·사업성", max: 20, hint: "배포된 서비스의 완성도와 사업성 근거" },
    ],
  },
};

export const TRACK_IDS = Object.keys(TRACKS);
export const DEFAULT_TRACK = "paper";

export function trackOf(id: unknown): TrackDef {
  return TRACKS[typeof id === "string" && TRACKS[id] ? id : DEFAULT_TRACK];
}
export function reportsOf(id: unknown): ReportDef[] {
  return trackOf(id).reports ?? [];
}
/** 평가 기준: 마일스톤 전용 기준이 있으면 그것, 없으면 트랙 루브릭 */
export function rubricOf(track: unknown, milestone?: string | null): RubricAxis[] {
  const r = milestone ? reportsOf(track).find((x) => x.id === milestone) : undefined;
  return r?.rubric ?? trackOf(track).rubric;
}
/** 마일스톤 전용 기준이면 모든 문항 필수 */
export function rubricRequired(track: unknown, milestone?: string | null): boolean {
  return !!(milestone && reportsOf(track).find((x) => x.id === milestone)?.rubric);
}
export function rubricMax(rubric: RubricAxis[]): number {
  return rubric.reduce((a, x) => a + x.max, 0);
}
export function isTrack(v: unknown): v is string {
  return typeof v === "string" && !!TRACKS[v];
}
export function stagesOf(track: unknown): StageDef[] {
  return trackOf(track).stages;
}
export function stageIds(track: unknown): string[] {
  return stagesOf(track).map((s) => s.id);
}
/** 트랙 안에서 유효한 단계인지 */
export function isStageOf(track: unknown, v: unknown): v is string {
  return typeof v === "string" && stageIds(track).includes(v);
}
/** 어느 트랙이든 존재하는 단계 id 인지 (필터 등 트랙 무관 검증용) */
const ALL_STAGE_MAP: Record<string, StageDef & { track: string }> = Object.fromEntries(
  Object.values(TRACKS).flatMap((t) => t.stages.map((s) => [s.id, { ...s, track: t.id }]))
);
export function isStage(v: unknown): v is string {
  return typeof v === "string" && !!ALL_STAGE_MAP[v];
}
export function stageLabel(id: string): string {
  return ALL_STAGE_MAP[id]?.label ?? id;
}
export function stageHint(id: string): string {
  return ALL_STAGE_MAP[id]?.hint ?? "";
}
export function stageIndexOf(track: unknown, id: string): number {
  return stageIds(track).indexOf(id);
}
export const ALL_STAGE_IDS = Object.keys(ALL_STAGE_MAP);

// ---- 하위 호환 (논문 트랙 상수) ----
export const STAGES = TRACKS.paper.stages.map((s) => s.id) as readonly string[];
export type Stage = string;
export const STAGE_LABELS: Record<string, string> = Object.fromEntries(Object.entries(ALL_STAGE_MAP).map(([k, v]) => [k, v.label]));
export const STAGE_HINTS: Record<string, string> = Object.fromEntries(Object.entries(ALL_STAGE_MAP).map(([k, v]) => [k, v.hint]));

export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export const STAGE_STATUSES = ["todo", "doing", "done"] as const;
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export const REVIEW_STATUSES = ["none", "requested", "changes_requested", "approved"] as const;
