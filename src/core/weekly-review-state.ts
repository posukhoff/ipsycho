import { z } from "zod";

export const WeeklyReviewDimensionSchema = z.object({
  status: z.enum(["provided", "skipped"]),
  summary: z.string().min(1).max(1000),
}).strict();

export const WeeklyReviewProgressSchema = z.object({
  outcome: WeeklyReviewDimensionSchema.nullable(),
  capacityEnergy: WeeklyReviewDimensionSchema.nullable(),
  risks: WeeklyReviewDimensionSchema.nullable(),
  minimumSuccess: WeeklyReviewDimensionSchema.nullable(),
  commitments: WeeklyReviewDimensionSchema.nullable(),
  conclusionRequested: z.boolean(),
}).strict();

export const WeeklyReviewStateSchema = WeeklyReviewProgressSchema.extend({ version: z.literal(1) }).strict();
export type WeeklyReviewProgress = z.infer<typeof WeeklyReviewProgressSchema>;
export type WeeklyReviewState = z.infer<typeof WeeklyReviewStateSchema>;
export type WeeklyReviewDimension = keyof Pick<WeeklyReviewState, "outcome" | "capacityEnergy" | "risks" | "minimumSuccess" | "commitments">;

export function emptyWeeklyReviewState(): WeeklyReviewState {
  return { version: 1, outcome: null, capacityEnergy: null, risks: null, minimumSuccess: null, commitments: null, conclusionRequested: false };
}

export function parseWeeklyReviewState(value: unknown): WeeklyReviewState {
  const parsed = WeeklyReviewStateSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyWeeklyReviewState();
}

export function mergeWeeklyReviewProgress(current: unknown, progress: WeeklyReviewProgress | null | undefined): WeeklyReviewState {
  const state = parseWeeklyReviewState(current);
  if (!progress) return state;
  return {
    version: 1,
    outcome: progress.outcome ?? state.outcome,
    capacityEnergy: progress.capacityEnergy ?? state.capacityEnergy,
    risks: progress.risks ?? state.risks,
    minimumSuccess: progress.minimumSuccess ?? state.minimumSuccess,
    commitments: progress.commitments ?? state.commitments,
    conclusionRequested: state.conclusionRequested || progress.conclusionRequested,
  };
}

export function missingWeeklyReviewDimensions(state: WeeklyReviewState): WeeklyReviewDimension[] {
  return (["outcome", "capacityEnergy", "risks", "minimumSuccess", "commitments"] as const).filter((key) => state[key] === null);
}

export function weeklyReviewLifecycle(state: WeeklyReviewState, clarificationCountBeforeTurn: number): { complete: boolean; forced: boolean; assumptionsRequired: boolean } {
  const missing = missingWeeklyReviewDimensions(state);
  const forced = state.conclusionRequested || clarificationCountBeforeTurn >= 3;
  return { complete: missing.length === 0 || forced, forced, assumptionsRequired: forced && missing.length > 0 };
}

export function questionForMissingWeeklyDimension(state: WeeklyReviewState): string | null {
  const first = missingWeeklyReviewDimensions(state)[0];
  if (!first) return null;
  if (first === "outcome") return "Какой один измеримый результат сделает следующую неделю успешной?";
  if (first === "capacityEnergy") return "Сколько у тебя реально есть времени и в какие дни или часы энергия обычно ниже?";
  if (first === "risks") return "Что с наибольшей вероятностью сорвёт этот результат или уже блокирует работу?";
  if (first === "minimumSuccess") return "Как выглядит минимально достаточный результат недели, если всё пойдёт сложнее ожидаемого?";
  return "Какие уже назначенные встречи и обязательства обязательно нужно учесть в плане?";
}
