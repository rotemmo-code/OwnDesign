// The only file with colour values: the screen, the legend and the PDF all read them from here.

/** In precedence order. */
export type WallKind = 'removed' | 'added' | 'moved' | 'mamad' | 'exterior' | 'existing';

export const COLOR = {
  exterior: '#1F4E79',
  mamad: '#7B2D8E',
  existing: '#5B6470',
  /** An inner wall classed fixed (owner, round 12: told by colour, no mark): at least 3 : 1 against paper and against existing. */
  fixed: '#0E1216',
  moved: '#B45000',
  added: '#1B7F46',
  removed: '#C62828',
  finish: '#C2327F',
  dimension: '#00727D',
  ink: '#1A1A1A',
  paper: '#FFFFFF',
} as const;

/** Colour never stands alone: each kind also has a fill and an outline. */
export const KIND_STYLE: Record<WallKind, { fill: 'solid' | 'hatch' | 'none'; dashed: boolean }> = {
  removed: { fill: 'none', dashed: true },
  added: { fill: 'hatch', dashed: false },
  moved: { fill: 'solid', dashed: false },
  mamad: { fill: 'solid', dashed: false },
  exterior: { fill: 'solid', dashed: false },
  existing: { fill: 'solid', dashed: false },
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}
