export function estimateTokenCost(input: number, output: number, requests: number, inputRate: number, outputRate: number) {
  if ([input, output, requests, inputRate, outputRate].some((value) => !Number.isFinite(value) || value < 0)) return null;
  const estimate = (input * inputRate + output * outputRate) / 1_000_000 * requests;
  return Number.isFinite(estimate) ? estimate : null;
}
