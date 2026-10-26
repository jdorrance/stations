import * as upstream from '@azohra/meteo.station/server';
import { providerFetch } from './transport.ts';

/** Preserve upstream environment contracts while sharing a managed transport. */
export function resolveEnvironment(environment?: upstream.ServerEnvironment): upstream.ResolvedEnvironment {
  return upstream.resolveEnvironment({ ...environment, fetch: providerFetch(environment?.fetch) });
}

function withEnvironment<T extends { environment?: upstream.ServerEnvironment }>(options: T) {
  return { ...options, environment: resolveEnvironment(options.environment) };
}

export function defineStationAdapter<C, O extends upstream.StationAdapterOptions = upstream.StationAdapterOptions>(
  definition: upstream.StationAdapterDefinition<C, O>,
): upstream.StationAdapter<C, O> {
  return upstream.defineStationAdapter({
    ...definition,
    load: (config, context) => definition.load(config, {
      ...context, environment: resolveEnvironment(context.options.environment),
    }),
  });
}

export function createStationFeedHandler(options: upstream.StationFeedHandlerOptions): upstream.StationFeedHandler {
  return upstream.createStationFeedHandler(withEnvironment(options));
}

export function loadStationCurrent(options: upstream.LoadStationCurrentOptions) {
  return upstream.loadStationCurrent(withEnvironment(options));
}

export function loadStationFeed(options: upstream.LoadStationFeedOptions) {
  return upstream.loadStationFeed(withEnvironment(options));
}

export function loadStationHistory(options: upstream.LoadStationHistoryOptions) {
  return upstream.loadStationHistory(withEnvironment(options));
}

export function loadStationClimatology(options: upstream.LoadStationClimatologyOptions) {
  return upstream.loadStationClimatology(withEnvironment(options));
}

export function openStationLive(options: upstream.OpenStationLiveOptions) {
  return upstream.openStationLive(withEnvironment(options));
}

export function fetchUpstreamText(environment: upstream.ResolvedEnvironment, request: upstream.UpstreamTextRequest) {
  return upstream.fetchUpstreamText(resolveEnvironment(environment), request);
}

export function fetchUpstreamStream(environment: upstream.ResolvedEnvironment, request: upstream.UpstreamStreamRequest) {
  return upstream.fetchUpstreamStream(resolveEnvironment(environment), request);
}
