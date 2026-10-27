import type { ProviderCredentials } from '@stations/providers';

/**
 * Worker secret names and the provider credential each one supplies.
 *
 * This table is the single owner of the list: the deploy workflow mirrors
 * exactly these GitHub Actions secrets onto the Worker, `wrangler dev` reads
 * them from `.dev.vars`, and absent entries leave that network unconfigured
 * (its stations report `not_configured` instead of failing the feed).
 */
export const PROVIDER_SECRET_FIELDS = {
  HOLFUY_API_KEY: 'holfuyApiKey',
  TEMPEST_TOKEN: 'tempestToken',
  WU_API_KEY: 'wuApiKey',
  SYNOPTIC_TOKEN: 'synopticToken',
  SYNOPTIC_API_KEY: 'synopticApiKey',
  ECOWITT_APP_KEY: 'ecowittApplicationKey',
  ECOWITT_API_KEY: 'ecowittApiKey',
  AMBIENT_API_KEY: 'ambientApiKey',
  AMBIENT_APP_KEY: 'ambientApplicationKey',
} as const satisfies Record<string, keyof ProviderCredentials>;

export type ProviderSecretName = keyof typeof PROVIDER_SECRET_FIELDS;
type ProviderCredentialField = (typeof PROVIDER_SECRET_FIELDS)[ProviderSecretName];

export const PROVIDER_SECRET_NAMES: readonly ProviderSecretName[] = Object.keys(
  PROVIDER_SECRET_FIELDS,
) as ProviderSecretName[];

/** Secrets as the Worker sees them: every name optional, values are raw strings. */
export type ProviderSecretEnv = Partial<Record<ProviderSecretName, string>>;

/** Maps Worker secrets onto provider credentials. Blank values count as unset. */
export function credentialsFromEnv(env: ProviderSecretEnv): ProviderCredentials {
  const credentials: { -readonly [Field in ProviderCredentialField]?: string } = {};
  for (const name of PROVIDER_SECRET_NAMES) {
    const value = env[name]?.trim();
    if (value) credentials[PROVIDER_SECRET_FIELDS[name]] = value;
  }
  return credentials;
}
