/**
 * Skill helpers that read content collections (server side only). Kept apart from
 * `skills.ts`, which is plain data.
 */
import { getCollection } from 'astro:content';
import { skillByLabel, skills, type Skill } from './skills';

/** Slugs of the skills that have a long-form note in `src/content/skills/`. */
export async function skillsWithArticle(): Promise<Set<string>> {
  const entries = await getCollection('skills');
  for (const entry of entries) {
    if (!skills.some((s) => s.slug === entry.id)) {
      throw new Error(
        `src/content/skills/${entry.id}.mdx has no skill with slug "${entry.id}" in src/data/skills.ts.`,
      );
    }
  }
  return new Set(entries.map((e) => e.id));
}

export interface UsedAt {
  id: string;
  company: string;
}

/** Work entries that tag each skill, keyed by slug. */
export async function usedAtBySkill(): Promise<Map<string, UsedAt[]>> {
  const experience = (await getCollection('experience')).sort(
    (a, b) => a.data.order - b.data.order,
  );
  const map = new Map<string, UsedAt[]>();
  for (const job of experience) {
    for (const tag of job.data.tags) {
      const { slug } = skillByLabel(tag);
      map.set(slug, [...(map.get(slug) ?? []), { id: job.id, company: job.data.company }]);
    }
  }
  return map;
}

export const hasArticle = async (skill: Skill) => (await skillsWithArticle()).has(skill.slug);
