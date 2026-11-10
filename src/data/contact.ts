export interface ContactItem {
  label: string;
  value: string;
  /** Without `href`, the item is plain text. */
  href?: string;
  external?: boolean;
  /** Where the item sits on the contact board, beside the CPU. */
  side: 'left' | 'right';
}

export const contactItems: ContactItem[] = [
  {
    label: 'E-mail',
    value: 'pavel.akira.marek@gmail.com',
    href: 'mailto:pavel.akira.marek@gmail.com',
    side: 'left',
  },
  {
    label: 'GitHub',
    value: 'github.com/Akirathan',
    href: 'https://github.com/Akirathan',
    external: true,
    side: 'left',
  },
  {
    label: 'LinkedIn',
    value: 'in/pavel-marek-56a517140',
    href: 'https://www.linkedin.com/in/pavel-marek-56a517140/',
    external: true,
    side: 'right',
  },
  {
    label: 'Location',
    value: 'Brno, Czechia',
    side: 'right',
  },
];
