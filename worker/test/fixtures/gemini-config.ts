// The `gemini` runtime-config block every test config carries (data-model.md §R3).
export const TEST_GEMINI_CONFIG = {
  models: {
    tutor: "test-model",
    rewrite: "test-model",
    progress: "test-model",
    evidence: "test-model",
    condense: "test-model",
    judge: "test-model",
    repair: "test-model",
  },
  thinking_budget: { tutor: 0, rewrite: 0, judge: null, default: 0 },
  timeout_ms: { tutor: 20000, judge: 30000, default: 12000 },
  temperature: { tutor: 0.4, rewrite: 0.4, default: 0 },
  max_output_tokens: { tutor: 400, rewrite: 400, judge: 2000, default: 1000 },
};
