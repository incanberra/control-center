export const MAX_INDUSTRY_TOPICS = 24;
export type IndustryDiscoveryOptions = { country?: "AU" | "US" | "GB"; lookbackDays?: 1 | 3 | 7 };

export function industryDiscoveryOptions(input: IndustryDiscoveryOptions) {
  const country = input.country ?? "AU";
  const lookbackDays = input.lookbackDays ?? 1;
  if (!["AU", "US", "GB"].includes(country)) throw new Error("Choose Australia, United States or United Kingdom for topic discovery.");
  if (![1, 3, 7].includes(lookbackDays)) throw new Error("Choose a discovery window of 1, 3 or 7 days.");
  return { country, lookbackDays };
}

export function cleanIndustryTopics(keywords: string[]) {
  return [...new Set(keywords.map((keyword) => keyword.replaceAll('"', "").trim()).filter(Boolean))];
}

export function industryTopicEndpoints(keywords: string[], options: IndustryDiscoveryOptions = {}) {
  const { country, lookbackDays } = industryDiscoveryOptions(options);
  const cleaned = cleanIndustryTopics(keywords).slice(0, MAX_INDUSTRY_TOPICS);
  const endpoints: string[] = [];
  for (let index = 0; index < cleaned.length; index += 6) {
    const group = cleaned.slice(index, index + 6).map((keyword) => `"${keyword}"`).join(" OR ");
    const query = `(${group}) when:${lookbackDays}d`;
    const params = new URLSearchParams({ q: query, hl: `en-${country}`, gl: country, ceid: `${country}:en` });
    endpoints.push(`https://news.google.com/rss/search?${params}`);
  }
  return endpoints;
}
