// Public host contracts verified against dsh-llm's LlmConfigurableProvider:
// provider, settingsNs, settingsPath and nativeAuth.{env,oauth}. There is no
// public owner/recordKey field. dsh-llm-pi-ai owns records under
// `llm-pi-ai/${provider}` (RECORD_SCOPE / recordKeyFor), and its default directory
// uses settingsNs='llm-pi-ai', settingsPath=['providers', provider]. Only that
// verified address authorizes a native-record lookup; renamed instances cannot
// be identified through these public contracts and must use refs/nativeAuth.env.
// No provider aliases are assumed. In particular, a similar display name or URL
// does not establish that a different route owns Bailian/Breeze/Volcengine keys.
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const RECORD_ID = /^[a-z][a-z0-9-]*$/
const text = value => typeof value === 'string' ? value.trim() : ''
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)

function service(ctx, name) {
  try { return ctx?.get?.(name) } catch { return undefined }
}
function profileAt(form, path) {
  return path.reduce((value, segment) => own(value, segment) ? value[segment] : undefined, form?.value)
}
function piRecordKey(route) {
  const path = route.settingsPath
  return route.settingsNs === 'llm-pi-ai' && path.length === 2 && path[0] === 'providers' && path[1] === route.provider && RECORD_ID.test(route.provider)
    ? `llm-pi-ai/${route.provider}` : undefined
}

/**
 * Exact export: createModelCredentialResolver(ctx).
 * Returns async resolve(provider, {credentialRef} = {}) ->
 * {key?, source:'provider', provider, configured, routeAvailable, credentialRef?, recordKey?, error?}.
 *
 * Resolves once per operation; neither credentials nor settings are cached.
 * A route's explicit apiKeyEnv is authoritative, including an invalid or missing
 * reference: it never falls back to caller refs, native records or environment.
 * With no route, an explicitly supplied credentialRef is still usable (notably
 * for Breeze when no model adapter registers it). No unknown records are read.
 * Only server callers may use key; status endpoints must strip it before reply.
 * No credential-file access, ambient process.env access, or credential mutation.
 */
export function createModelCredentialResolver(ctx) {
  return async function resolveModelCredential(provider, {credentialRef} = {}) {
    const result = {source: 'provider', provider, configured: false, routeAvailable: false}
    const missing = error => ({...result, error})
    if (typeof provider !== 'string' || !provider || provider !== provider.trim()) return missing('Invalid model provider')
    const credentials = service(ctx, 'credentials')
    const resolveRef = async ref => {
      if (typeof ref !== 'string' || !REF.test(ref)) return missing('Invalid credential reference')
      result.credentialRef = ref
      if (!credentials?.resolve) return missing('DSH credentials service is unavailable')
      const key = text((await credentials.resolve(ref))?.value)
      return key ? {...result, configured: true, key} : missing('Credential reference is not configured; configure it in DSH credentials')
    }
    try {
      const routes = await service(ctx, 'llm')?.listConfigurableProviders?.() || []
      if (!Array.isArray(routes)) return missing('DSH model provider directory is invalid')
      const route = routes.find(entry => entry?.provider === provider)
      result.routeAvailable = !!route
      if (!route) {
        if (credentialRef !== undefined) return await resolveRef(credentialRef)
        return missing('Model provider route is unavailable; configure a DSH model provider or supply an explicit credential reference')
      }
      if (typeof route.settingsNs !== 'string' || !Array.isArray(route.settingsPath) || route.settingsPath.some(segment => typeof segment !== 'string')) return missing('Model provider settings address is invalid')
      const settings = service(ctx, 'settings')
      if (!settings?.describe) return missing('DSH settings service is unavailable; cannot determine model credential reference')
      const forms = await settings.describe({redactSecrets: true})
      if (!Array.isArray(forms)) return missing('DSH model settings description is invalid')
      const form = forms.find(entry => entry?.ns === route.settingsNs)
      if (!form) return missing('Model provider settings are unavailable; cannot determine model credential reference')
      const profile = profileAt(form, route.settingsPath)
      if (own(profile, 'apiKeyEnv') && profile.apiKeyEnv !== undefined) return await resolveRef(profile.apiKeyEnv)
      if (!credentials) return missing('DSH credentials service is unavailable')
      const recordKey = piRecordKey(route)
      if (recordKey) result.recordKey = recordKey
      const record = recordKey && credentials.readRecord ? await credentials.readRecord(recordKey) : undefined
      if (record?.kind === 'api-key') {
        const key = text(record.key)
        if (key) return {...result, configured: true, key}
      }
      // OAuth grants are opaque to their owner; never interpret a token as an
      // API key. Only names explicitly advertised by nativeAuth may be resolved.
      const names = Array.isArray(route.nativeAuth?.env) ? route.nativeAuth.env : []
      for (const ref of names) {
        if (typeof ref !== 'string' || !REF.test(ref)) continue
        if (!recordKey && !result.credentialRef) result.credentialRef = ref
        const storedKey = text(record?.kind === 'api-key' && own(record.env, ref) ? record.env[ref] : undefined)
        if (storedKey) return {...result, configured: true, key: storedKey}
        const key = text(credentials.resolve ? (await credentials.resolve(ref))?.value : undefined)
        if (key) return {...result, configured: true, credentialRef: ref, key}
      }
      return missing('No usable model API credential; configure a credential reference in the DSH model settings')
    } catch {
      // Host exceptions may include key material; do not forward their message.
      return missing('DSH model credential resolution failed')
    }
  }
}
