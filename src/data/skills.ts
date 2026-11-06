/**
 * Skills as keywords. The single source for the /skills page, the chips on the landing page,
 * and the tag links on experience pages.
 *
 * Experience `tags` (in src/content/experience) must match a `label` here exactly; the work
 * detail page fails the build otherwise.
 */
export interface Skill {
  label: string;
  /**
   * URL fragment on /skills (`/skills#java`), the file name of an optional note in
   * `src/content/skills/`, and of an optional icon in `src/assets/skills/`.
   */
  slug: string;
  /** One short line, optional. Shown as the tagline of the long-form note. */
  note?: string;
  /** Self-assessed expertise, an integer from 1 to 10. Shown as a meter in the chip on /skills. */
  expertise?: number;
}

export interface SkillCategory {
  title: string;
  skills: Skill[];
}

export const skillCategories: SkillCategory[] = [
  {
    title: 'Languages',
    skills: [
      { label: 'Java', slug: 'java', note: 'The language I am fastest in.', expertise: 9 },
      { label: 'Scala', slug: 'scala', expertise: 7 },
      { label: 'R', slug: 'r', note: 'Implemented it, not only used it.', expertise: 8 },
      { label: 'Python', slug: 'python', expertise: 7 },
      { label: 'C', slug: 'c' },
      { label: 'C++', slug: 'cpp', expertise: 5 },
      { label: 'Rust', slug: 'rust', expertise: 7 },
      { label: 'TypeScript', slug: 'typescript', expertise: 7 },
      { label: 'Liquid', slug: 'liquid', expertise: 8 },
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

for (const s of skills) {
  if (
    s.expertise !== undefined &&
    !(Number.isInteger(s.expertise) && s.expertise >= 1 && s.expertise <= 10)
  ) {
    throw new Error(
      `Skill "${s.label}": expertise must be an integer from 1 to 10, got ${s.expertise}.`,
    );
  }
}

const byLabel = new Map(skills.map((s) => [s.label, s]));

/** Finds a skill by its exact label. Throws, so that a typo in a tag fails the build. */
export function skillByLabel(label: string): Skill {
  const skill = byLabel.get(label);
  if (!skill) {
    throw new Error(`Unknown skill tag "${label}". Add it to src/data/skills.ts or fix the tag.`);
  }
  return skill;
}

/** The chip's place on the keywords page. */
export const skillHref = (skill: Skill) => `/skills#${skill.slug}`;

/** The long-form note, if `src/content/skills/<slug>.mdx` exists. */
export const skillArticleHref = (skill: Skill) => `/skills/${skill.slug}`;

export function skillCategoryOf(skill: Skill): SkillCategory {
  return skillCategories.find((c) => c.skills.includes(skill))!;
}

// Icons are PNG files named after the slug. Only some skills have one (official logos exist
// for languages; most tools do not need one).
const icons = import.meta.glob<ImageMetadata>('../assets/skills/*.png', {
  eager: true,
  import: 'default',
});

export function skillIcon(skill: Skill): ImageMetadata | undefined {
  return icons[`../assets/skills/${skill.slug}.png`];
}
