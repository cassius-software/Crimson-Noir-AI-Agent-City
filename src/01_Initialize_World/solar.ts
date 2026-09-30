/**
 * Why does this file exist? The civic solar cycle: where the sun is for a given local solar time,
 * latitude and declination (standard spherical astronomy, no equation-of-time correction), plus the
 * daylight curve the lighting, sky and street lamps key off.
 * What breaks if it is removed? The sun stops moving and night never falls.
 */

/** Toronto, late September. */
export const SITE = { latitude: 43.65, declination: -1.2 } as const

export interface SunState {
  /** Unit vector toward the sun. North is −z, east is +x, south is +z. */
  x: number
  y: number
  z: number
  elevationDeg: number
  azimuthDeg: number
  /** 0 at night, 1 in full daylight; civil twilight in between. */
  daylight: number
}

const RAD = Math.PI / 180

export function sunAt(hours: number, latitude: number = SITE.latitude, declination: number = SITE.declination): SunState {
  const lat = latitude * RAD
  const dec = declination * RAD
  const H = (hours - 12) * 15 * RAD
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)))
  // Azimuth measured clockwise from north.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI
  const c = Math.cos(el)
  const elevationDeg = el / RAD
  const t = Math.max(0, Math.min(1, (elevationDeg + 6) / 14))
  return {
    x: Math.sin(az) * c,
    y: Math.sin(el),
    z: -Math.cos(az) * c,
    elevationDeg,
    azimuthDeg: ((az / RAD) % 360 + 360) % 360,
    daylight: t * t * (3 - 2 * t),
  }
}

export function formatClock(hours: number): string {
  const h = ((hours % 24) + 24) % 24
  const hh = Math.floor(h)
  const mm = Math.floor((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
