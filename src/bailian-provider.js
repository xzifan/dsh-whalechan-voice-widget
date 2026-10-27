import {createModelCredentialResolver} from './model-credentials.js'

// Compatibility adapter: provider lookup and precedence belong to the shared
// resolver. New consumers use createModelCredentialResolver directly.
export function createBailianProviderResolver(ctx) {
  const resolve = createModelCredentialResolver(ctx)
  return async function resolveBailianProvider() {
    const result = await resolve('bailian')
    return result.key ? result : null
  }
}
