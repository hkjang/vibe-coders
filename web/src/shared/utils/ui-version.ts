const releaseVersion = /^v\d+\.\d+\.\d+/u;

/**
 * Whether this tab is running an older console than the server now embeds, which happens
 * after an upgrade while the tab stays open. Only release versions are compared, so
 * development and CI builds never warn about their synthetic versions.
 */
export function staleBundle(loaded: string, served: string): boolean {
  return releaseVersion.test(loaded) && releaseVersion.test(served) && loaded !== served;
}
