// Only URL credentials in authentication routes (or explicit OAuth token fields).
// Never apply to action inputs or internal observation signatures.
const urls = /https?:\/\/[^\s<>"']+/gi
const credential = /^(?:key|code|token|ticket|secret|access_token|id_token|refresh_token|auth_token)$/i
const explicitToken = /^(?:access_token|id_token|refresh_token|auth_token)$/i
export function redactAuthUrls(text) {
 return String(text).replace(urls, raw => {
  let url; try { url = new URL(raw) } catch { return raw }
  const auth = /(?:^|[\/_.-])(?:auth|oauth2?|login|signin|sign-in|callback|verify|verification|magic-link)(?:[\/_.-]|$)/i.test(url.pathname)
  return raw.replace(/([?&#])([^=&#]+)=([^&#]*)/g, (part, sep, key) => {
   let name; try { name=decodeURIComponent(key) } catch { return part }
   return (auth ? credential : explicitToken).test(name) ? `${sep}${key}=[REDACTED]` : part
  })
 })
}
export function sanitizePublic(value) {
 if(typeof value==='string') return redactAuthUrls(value)
 if(Array.isArray(value)) return value.map(sanitizePublic)
 if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitizePublic(v)]))
 return value
}
export function hasAuthUrlSecrets(value) { return JSON.stringify(value)!==JSON.stringify(sanitizePublic(value)) }
export function sanitizePublicError(error) {
 if(error && typeof error==='object') {
  const descriptors=Object.getOwnPropertyDescriptors(error)
  for(const descriptor of Object.values(descriptors))if('value' in descriptor)descriptor.value=sanitizePublic(descriptor.value)
  return Object.create(Object.getPrototypeOf(error),descriptors)
 }
 return typeof error==='string'?redactAuthUrls(error):error
}
