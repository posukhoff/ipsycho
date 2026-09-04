export function voiceWithinLimits(input: { durationSeconds: number; bytes: number; maxDurationSeconds: number; maxBytes: number }): boolean {
  return input.durationSeconds > 0 && input.bytes >= 0 && input.durationSeconds <= input.maxDurationSeconds && input.bytes <= input.maxBytes;
}
