import type { FeedbackChoice } from "./types";

export const feedbackLabels: Record<FeedbackChoice, string> = {
  useful: "Useful", "too-routine": "Too routine", "off-topic": "Off-topic", "already-knew": "Already knew",
};
export const feedbackDescriptions: Record<FeedbackChoice, string> = {
  useful: "Substantive evidence worth following.",
  "too-routine": "Relevant, but not consequential enough.",
  "off-topic": "Outside your research interests.",
  "already-knew": "Repeats a development you already know.",
};
export const MAX_FEEDBACK_REASON = 500;
