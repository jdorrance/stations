import type { ServerEnvironment, StationConfigInput } from '@azohra/meteo.station/server';
import type { CatalogueStation, LaunchSite, StationVendor } from '@stations/contracts';
import type { Bounds, Coverage, RegionCode } from '@stations/geography';

export interface ProviderCredentials {
  readonly tempestToken?: string;
  readonly tempestTokens?: Readonly<Record<string, string>>;
  readonly ecowittApplicationKey?: string;
  readonly ecowittApiKey?: string;
  readonly holfuyApiKey?: string;
  readonly holfuyPasswords?: Readonly<Record<string, string>>;
  readonly wuApiKey?: string;
  readonly synopticToken?: string;
  readonly ambientApiKey?: string;
  readonly ambientApplicationKey?: string;
}

export interface DiscoverOptions {
  readonly regions?: readonly RegionCode[];
  readonly bounds?: Bounds;
  readonly seeds?: readonly CatalogueStation[];
  readonly launches?: readonly LaunchSite[];
  readonly includeRemoteDiscovery?: boolean;
  readonly environment?: ServerEnvironment;
}

export interface StationNetworkProvider {
  readonly vendor: StationVendor;
  readonly coverage: Coverage;
  discover(options?: DiscoverOptions): Promise<CatalogueStation[]>;
  toStationConfig(
    station: CatalogueStation,
    credentials?: ProviderCredentials,
  ): StationConfigInput;
}
