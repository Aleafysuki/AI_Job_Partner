/**
 * @aijob/core —— AI Job Partner 核心业务层
 *
 * 约束：本包不 import 任何宿主相关能力（node:* / electron / DOM）。
 * 它可以在 Electron 渲染进程、Electron 主进程、浏览器、甚至将来的 Tauri / 服务端直接运行。
 * 这是文档第十七节「Windows / Android / Web 复用同一套核心逻辑」的前提。
 */

// ---------------- 版本与能力开关 ----------------
export * from './version';

// ---------------- 领域模型 ----------------
export * from './domain/common';
export * from './domain/evidence';
export * from './domain/profile';
export * from './domain/job';
export * from './domain/match';
export * from './domain/report';
export * from './domain/privacy';
export * from './domain/ai-trace';
export * from './domain/usage';
export * from './domain/interview';
export * from './domain/levels';
export * from './domain/training';
export * from './domain/interview-prep';
export * from './domain/debrief';
export * from './domain/review-preferences';

// ---------------- 隐私 ----------------
export { extractCity, redactPII } from './privacy/redactor';

// ---------------- 自然语言基础 ----------------
export * from './nlp/skills';
export * from './nlp/skill-questions';
export * from './nlp/skill-knowledge';
export * from './nlp/ask-planner';

// ---------------- 面试复盘基础（v0.2 追加） ----------------
export * from './debrief/dimensions';
export * from './debrief/anonymize';

// ---------------- 解析 ----------------
export * from './parsers/document';
export * from './parsers/resume-structure';

// ---------------- AI ----------------
export * from './ai/types';
export { AiGateway, createProvider, type GatewayOptions, type RunResult } from './ai/gateway';
export { OpenAiCompatibleProvider } from './ai/openai-compatible';
export { OllamaProvider } from './ai/ollama';
export * from './ai/prompts';
export {
  OpenAiCompatibleTranscriber,
  DisabledTranscriber,
  createTranscriber,
  buildMultipartBody,
  extractTranscriptText,
  TRANSCRIPTION_MAX_BYTES,
  type AiTranscriber,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionOutcome,
  type MultipartPart,
  type MultipartFile,
} from './ai/transcription';

// ---------------- 引擎 ----------------
export {
  buildProfile,
  finalizeProfile,
  type BuildProfileInput,
  type BuildProfileResult,
} from './engines/profile-builder';
export {
  analyzeJob,
  finalizeJob,
  type AnalyzeJobInput,
  type AnalyzeJobResult,
} from './engines/job-analyzer';
export { runMatching, type MatchInput, type MatchOutput } from './engines/matching-engine';
export { buildReport, explainWhyNot, type BuildReportInput } from './engines/report-builder';
export { buildMinimumCandidate, type MinimumCandidateResult } from './engines/minimum-candidate';
export {
  mergeProfiles,
  looksLikeSameCandidate,
  overlapScore,
  libraryHighlights,
  evidenceKey,
  type MergeReport,
  type MergeOptions,
} from './engines/profile-merge';
export {
  startAssessment,
  planAssessmentSession,
  recordAnswer,
  nextQuestion,
  computeSignals,
  deriveEvidenceFromSession,
  evaluateAssessment,
  pendingSkillsFor,
  assessedSkillsFor,
  assessFreshness,
  recordDraft,
  clearDraft,
  replanQuestions,
  estimateSessionMinutes,
  type StartAssessmentInput,
  type PlanSessionInput,
  type PlanSessionOutput,
  type AnswerInput,
  type EvaluateInput,
  type EvaluateOutput,
  type AssessmentSnapshot,
  type DerivedEvidence,
  type PendingSkill,
  type StaleMark,
} from './engines/skill-interview';
export {
  buildTrainingPlan,
  answerTrainingItem,
  parkTrainingItem,
  carryOverAnswers,
  trainingCandidates,
  TRAINING_MAX_ITEMS,
  type BuildTrainingInput,
  type BuildTrainingOutput,
} from './engines/training-planner';
export {
  judgeTrainingAnswer,
  TRAINING_EVIDENCE_WHY,
  type JudgeReason,
  type TrainingJudgement,
  type TrainingVerdict,
} from './engines/training-judge';
export {
  summarizeAnswer,
  summaryToEvidence,
  anchorIsReal,
  SUMMARY_DISCLAIMER,
  type AnswerSummary,
  type SummarizeInput,
  type SummaryField,
} from './engines/answer-summary';
export {
  prepareQuestions,
  splitQuestions,
  classifyQuestion,
  type PrepareQuestionsInput,
} from './engines/interview-prep';
export * from './engines/pipeline';

// ---------------- 面试复盘引擎（v0.2 追加） ----------------
export {
  buildInterviewDebrief,
  buildDebriefRulesOnly,
  extractEvidenceByRule,
  extractDebriefEvidence,
  analyzeDimensionsByRule,
  applyAiDimensions,
  buildPerformanceSummary,
  buildFitAssessment,
  synthesizeByRule,
  debriefDimensionSkeleton,
  debriefTurns,
  turnsFromSegment,
  segmentProgress,
  fitHeadline,
  debriefCoverage,
  classifyTopic,
  classifyEvidenceType,
  inferSpeaker,
  extractQuotas,
  extractPay,
  extractHours,
  MAX_DEBRIEF_EVIDENCE,
  type BuildDebriefInput,
  type BuildDebriefOutput,
  type SynthesizeOutput,
  type AiDimensionShape,
  type AiEvidenceShape,
  type QuotaHit,
  type PayHit,
  type HoursHit,
} from './engines/debrief-engine';
export { renderDebriefHtml, radarSvg, debriefHtmlFileName, type RenderDebriefOptions } from './engines/debrief-render';
export {
  renderMatchReportHtml,
  matchReportFileName,
  type RenderReportOptions,
} from './engines/match-report-render';

// ---------------- v0.4：模拟面试（generate / mock / analyze_answer / weak_point_training） ----------------
export {
  MOCK_DISCLAIMER,
  ANSWER_CHANNEL_LABEL,
  ANSWER_DIMENSION_LABEL,
  DIMENSION_VERDICT_LABEL,
  MOCK_KIND_LABEL,
  MOCK_STATUS_LABEL,
  QUESTION_SOURCE_LABEL,
  WEAKENING_ACTION_LABEL,
  DIMENSION_HEALTH_LABEL,
  HIT_RATE_LABEL,
  computeMockStats,
  nextQuestionOf,
  resolveMockLevel,
  type AnswerAnalysis,
  type AnswerChannel,
  type AnswerDimension,
  type DimensionFinding,
  type DimensionVerdict,
  type MockAnswer,
  type MockQuestion,
  type MockQuestionKind,
  type MockSession,
  type MockSessionStatus,
  type MockStats,
  type MockWeakness,
  type QuestionSource,
  type QuestionSourceRef,
  type WeakeningAction,
  type WeakeningInput,
  type WeakeningSuggestion,
  type FollowUpHook,
  type AnswerFeedbackView,
} from './domain/mock-interview';
export {
  // 交互式追问（v0.5）：问题从上���个回答里长出来
  extractFollowUpHooks,
  decideFollowUp,
  buildAnswerFeedback,
  MAX_FOLLOW_UPS_PER_QUESTION,
  type FollowUpDecision,
  type AnswerFeedback,
} from './engines/interactive-followup';
// 截图 OCR（v0.3 job.input_image）—— 引擎侧在各自宿主里，契约在这里共用
export {
  assembleOcrText,
  summarizeConfidence,
  needsManualReview,
  OCR_CONFIDENCE_LABEL,
  OCR_CONFIDENCE_WHY,
  OCR_LOW_CONFIDENCE,
  OCR_MAX_BYTES,
  OCR_SIZE_WHY,
  OCR_SCRIPT_LABEL,
  OCR_SCRIPT_WHY,
  type OcrBlock,
  type OcrConfidence,
  type OcrDraft,
  type OcrResult,
  type OcrScript,
} from './domain/ocr';
export {
  generateMockQuestions,
  analyzeAnswer,
  collectWeaknesses,
  buildWeakeningSuggestions,
  newMockSession,
  finishMockSession,
  type GenerateQuestionsInput,
  type GeneratedQuestionSet,
} from './engines/mock-interview';
export {
  buildResumeAdvice,
  RESUME_ADVICE_DISCLAIMER,
  SUGGESTION_KIND_LABEL,
  SUGGESTION_KIND_WHY,
  type ResumeAdvice,
  type ResumeSuggestion,
  type SuggestionKind,
} from './engines/resume-advice';

// ---------------- 存储 ----------------
export type { StoredAssessResult } from './storage';
export * from './storage';

// ---------------- 工具 ----------------
export * from './utils/text';

// ---------------- 示例数据 ----------------
export * from './samples';
