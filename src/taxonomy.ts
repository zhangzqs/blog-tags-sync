import { MergeResult, TagSyncConfig, TaxonomyRules } from './types';

export function normalizeTag(tag: string | undefined | null): string {
  if (!tag) return '';
  return String(tag)
    .replace(/[\s_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(tags: string[], sort = false): string[] {
  const seen = new Map<string, string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, normalized);
    }
  }
  const values = Array.from(seen.values());
  if (sort) {
    return values.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  return values;
}

function classifyTags(tags: string[], taxonomyRules: TaxonomyRules | null): Record<string, string> {
  if (!taxonomyRules) {
    return Object.fromEntries(tags.map((tag) => [tag, 'uncategorized']));
  }

  const classification: Record<string, string> = {};
  for (const tag of tags) {
    let assigned = false;
    for (const [category, rule] of Object.entries(taxonomyRules)) {
      const includes = rule.includes ?? [];
      const pattern = rule.pattern;
      if (includes.some((candidate) => normalizeTag(candidate).toLowerCase() === normalizeTag(tag).toLowerCase())) {
        classification[tag] = category;
        assigned = true;
        break;
      }
      if (pattern) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(tag)) {
            classification[tag] = category;
            assigned = true;
            break;
          }
        } catch {
          // ignore invalid regex
        }
      }
    }
    if (!assigned) {
      classification[tag] = 'uncategorized';
    }
  }
  return classification;
}

export function mergeTags(
  fromSource: string[],
  recommended: string[],
  historical: string[] | undefined,
  config: Pick<TagSyncConfig, 'sortTags' | 'taxonomyRules'>
): MergeResult {
  const historyPart = historical ? dedupe(historical, false) : [];
  const sourcePart = dedupe(fromSource, false);
  const ordered = [...historyPart, ...sourcePart, ...recommended];
  const unique = dedupe(ordered, config.sortTags);
  const existingSet = new Set([...historyPart, ...sourcePart].map((tag) => normalizeTag(tag).toLowerCase()));
  const added = unique.filter((tag) => !existingSet.has(normalizeTag(tag).toLowerCase()));
  const classification = classifyTags(unique, config.taxonomyRules);
  return {
    tags: unique,
    added,
    classification
  };
}
