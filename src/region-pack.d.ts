/**
 * Why does this file exist? The type of the pilot build's embedded region (vite.config.ts regionPack): the region
 * pack's gzipped bytes as base64, or null in every other build.
 * What breaks if it is removed? App.tsx's import of it does not type-check.
 */
declare module 'virtual:region-pack' {
  const pack: string | null
  export default pack
}
