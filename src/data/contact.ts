export type ContactIcon = 'mail' | 'github' | 'linkedin' | 'languages' | 'location' | 'timezone';

export interface ContactItem {
  label: string;
  icon: ContactIcon;
  /** One line, or several lines. */
  value: string | string[];
  /** Without `href`, the item is plain text. */
  href?: string;
  external?: boolean;
  /** Where the item sits on the contact board, beside the CPU. */
  side: 'left' | 'right';
}

export const contactItems: ContactItem[] = [
  {
    label: 'E-mail',
    icon: 'mail',
    value: 'pavel.akira.marek@gmail.com',
    href: 'mailto:pavel.akira.marek@gmail.com',
    side: 'left',
  },
  {
    label: 'GitHub',
    icon: 'github',
    value: 'github.com/Akirathan',
    href: 'https://github.com/Akirathan',
    external: true,
    side: 'left',
  },
  {
    label: 'Languages',
    icon: 'languages',
    value: ['English: professional', 'German: B2', 'Czech: native'],
    side: 'left',
  },
  {
    label: 'LinkedIn',
    icon: 'linkedin',
    value: 'in/pavel-marek-56a517140',
    href: 'https://www.linkedin.com/in/pavel-marek-56a517140/',
    external: true,
    side: 'right',
  },
  {
    label: 'Location',
    icon: 'location',
    value: 'Brno, Czechia',
    side: 'right',
  },
  {
    label: 'Time zone',
    icon: 'timezone',
    value: ['CET (UTC+1)', 'CEST (UTC+2) in summer'],
    side: 'right',
  },
];
