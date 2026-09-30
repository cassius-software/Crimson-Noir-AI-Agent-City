/**
 * Why does this file exist? It is the product's brand mark (the Monolith) as a React component, used in
 * the HUD header and on the title card. The paths are identical to MONOLITH_SVG in brand.ts, which the
 * favicon uses, so every surface shows the same mark; only the rendered size varies.
 * What breaks if it is removed? The HUD header and the title card lose the logo (the build fails).
 */
import { useId } from 'react'
import { BRAND } from './brand.ts'

/** `title` is the accessible name (default: the product name). Pass '' where adjacent text already
 *  names the product: the mark is then decorative and hidden from assistive technology. */
export function MonolithLogo({ size = 120, title }: { size?: number; title?: string }) {
  const titleId = useId()
  const label = title ?? BRAND.name
  const a11y = label
    ? { role: 'img', 'aria-labelledby': titleId }
    : { 'aria-hidden': true, focusable: false }
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0px 10px 15px rgba(0, 0, 0, 0.2))' }} {...a11y}>
      {label && <title id={titleId}>{label}</title>}
      <rect width="120" height="120" rx="28" fill="#000000" />
      <path fillRule="evenodd" clipRule="evenodd" d="M60 25L90 77H30L60 25ZM60 48L46 72H74L60 48Z" fill="#FFFFFF" />
    </svg>
  )
}
