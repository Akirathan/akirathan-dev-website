/**
 * Skills as keywords. The single source for the /skills page, the chips on the landing page,
 * and the tag links on experience pages.
 *
 * Experience `tags` (in src/content/experience) must match a `label` here exactly; the work
 * detail page fails the build otherwise.
 */
export interface Skill {
  label: string;
  /** URL fragment on /skills, e.g. `/skills#java`. */
  slug: string;
  /** One short line, optional. */
  note?: string;
}

export interface SkillCategory {
  title: string;
  skills: Skill[];
}

export const skillCategories: SkillCategory[] = [
  {
    title: 'Languages',
    skills: [
      { label: 'Java', slug: 'java', note: 'The language I am fastest in.' },
      { label: 'Scala', slug: 'scala' },
      { label: 'R', slug: 'r', note: 'Implemented it, not only used it.' },
      { label: 'Python', slug: 'python' },
      { label: 'C', slug: 'c' },
      { label: 'C++', slug: 'cpp' },
      { label: 'TypeScript', slug: 'typescript' },
      { label: 'Liquid', slug: 'liquid' },
    ],
  },
  {
    title: 'Compilers & runtimes',
    skills: [
      { label: 'Compilers', slug: 'compilers', note: 'Static and dynamic.' },
      { label: 'Interpreters', slug: 'interpreters' },
      { label: 'GraalVM', slug: 'graalvm' },
      { label: 'Truffle', slug: 'truffle' },
      { label: 'Native Image', slug: 'native-image' },
      { label: 'JPMS', slug: 'jpms', note: 'Java Platform Module System.' },
      { label: 'Benchmarking', slug: 'benchmarking' },
      { label: 'Language design', slug: 'language-design' },
    ],
  },
  {
    title: 'Web & e-commerce',
    skills: [
      { label: 'Shopify', slug: 'shopify' },
      { label: 'Vue.js', slug: 'vue' },
      { label: 'Nuxt', slug: 'nuxt' },
      { label: 'Astro', slug: 'astro', note: 'This site.' },
      { label: 'Tailwind CSS', slug: 'tailwind' },
    ],
  },
  {
    title: 'Infrastructure & hardware',
    skills: [
      { label: 'Infrastructure', slug: 'infrastructure', note: 'On-premises and self-hosted.' },
      { label: 'Hetzner', slug: 'hetzner' },
      { label: 'Frigate', slug: 'frigate' },
      { label: 'STM32', slug: 'stm32' },
      { label: 'Embedded firmware', slug: 'embedded' },
      { label: '3D printing', slug: '3d-printing' },
      { label: 'CAD', slug: 'cad', note: 'OnShape, Autodesk Fusion, Blender.' },
    ],
  },
  {
    title: 'AI & tooling',
    skills: [
      { label: 'Claude Code', slug: 'claude-code', note: 'Daily, with custom skills.' },
      { label: 'AI agents', slug: 'ai-agents' },
      { label: 'Git', slug: 'git' },
      { label: 'Open source', slug: 'open-source' },
    ],
  },
];

export const skills: Skill[] = skillCategories.flatMap((c) => c.skills);

const byLabel = new Map(skills.map((s) => [s.label, s]));

/** Finds a skill by its exact label. Throws, so that a typo in a tag fails the build. */
export function skillByLabel(label: string): Skill {
  const skill = byLabel.get(label);
  if (!skill) {
    throw new Error(`Unknown skill tag "${label}". Add it to src/data/skills.ts or fix the tag.`);
  }
  return skill;
}

export const skillHref = (skill: Skill) => `/skills#${skill.slug}`;
