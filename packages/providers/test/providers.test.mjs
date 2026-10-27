import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCache } from '@azohra/meteo.station/server';
import {
  INITIAL_SEED_STATIONS,
  createProviderFetch,
  createStationsApiHandler,
  discoverStations,
  loadAwcStation,
  loadHolfuyStation,
  loadOpenWindMapStation,
  parseAmbientDeviceObservation,
  parseAprsWxPacket,
  parseAvalancheCanadaMeasurements,
  parseAvalancheCanadaStations,
  parseAwcMetarList,
  parseConaguaEmaObservation,
  parseConaguaEmasCatalogue,
  parseEcccSwobRealtime,
  parseEcccSwobStations,
  parseHolfuyObservation,
  parseHolfuyWidgetJson,
  parseIemCurrentsResponse,
  parseIemNetworkGeoJson,
  parseNdbcLatestObs,
  parseNdbcRealtime2,
  parseNwsLatestObservation,
  parseNwsStationsCollection,
  parseOpenWindMapArchive,
  parseRawsFeatureCollection,
  parseRealtimeTxt,
  parseSnotelDataResponse,
  parseSnotelStationsList,
  parseSynopticLatest,
  parseWeatherLinkBulletin,
  parseWindGuruCurrent,
  parseWindsMobiHistoric,
  parseWindsMobiList,
  parseWindSpionList,
  parseWindyPwsResponse,
  parseWuPwsCurrent,
  unwrapAggregatorStation,
} from '../dist/index.js';

const openWindMapFixture = JSON.stringify({
  data: [
    {
      id: 618,
      meta: { name: 'Monte Alto Launch (Valle de Bravo)' },
      location: { latitude: 19.1672, longitude: -100.1235, altitude: 2150 },
      measurements: {
        date: '2026-10-26T18:00:00.000Z',
        wind_heading: 225,
        wind_speed_avg: 18.0,
        wind_speed_max: 25.2,
        wind_speed_min: 10.8,
        pressure: 1014.2,
      },
    },
    {
      id: 999,
      meta: { name: 'Chamonix Planpraz' },
      location: { latitude: 45.936, longitude: 6.851, altitude: 2000 },
      measurements: {
        date: '2026-10-26T18:00:00.000Z',
        wind_heading: 180,
        wind_speed_avg: 12.0,
        wind_speed_max: 16.0,
        wind_speed_min: 8.0,
        pressure: null,
      },
    },
  ],
});

const holfuyFixture = JSON.stringify({
  stationId: 1652,
  stationName: 'Hatis 300 Launch',
  dateTime: '2026-10-26 18:02:00',
  wind: {
    speed: 6.4,
    gust: 9.1,
    min: 4.2,
    unit: 'm/s',
    direction: 195,
  },
  temperature: 16.2,
  humidity: 48,
  pressure: 1016.5,
  battery: 12.8,
});

const awcMetarFixture = JSON.stringify([
  {
    icaoId: 'UDYZ',
    name: 'Yerevan Zvartnots International',
    lat: 40.147,
    lon: 44.396,
    elev: 865,
    obsTime: 1793037600,
    wdir: 240,
    wspd: 10,
    wgst: 16,
    temp: 19.0,
    dewp: 7.0,
    slp: 1015.4,
  },
]);

test('OpenWindMap, Holfuy, and AWC parsers normalize upstream payloads to SI units and @azohra/meteo.station Reading contracts', () => {
  const owm = parseOpenWindMapArchive(openWindMapFixture);
  assert.equal(owm.length, 2);
  assert.equal(owm[0].station.uid, 'openwindmap:618');
  assert.equal(owm[0].station.country, null);
  assert.equal(owm[0].reading.windAvgMps, 5);
  assert.equal(owm[0].reading.windGustMps, 7);
  assert.equal(owm[0].reading.windLullMps, 3);
  assert.equal(owm[0].reading.windDirectionDeg, 225);
  assert.equal(owm[0].reading.conditions?.seaLevelPressureHpa, 1014.2);

  const holfuy = parseHolfuyObservation(holfuyFixture, '1652');
  assert.equal(holfuy.reading.windAvgMps, 6.4);
  assert.equal(holfuy.reading.windGustMps, 9.1);
  assert.equal(holfuy.reading.windDirectionDeg, 195);
  assert.equal(holfuy.reading.temperatureC, 16.2);
  assert.equal(holfuy.telemetry?.batteryVoltage, 12.8);

  const holfuyWidget = parseHolfuyWidgetJson(
    JSON.stringify({ timestamp: 1793037600, speed: 18, gust: 25.2, dir: 190, temperature: 15.0 }),
    1793037600000,
  );
  assert.equal(holfuyWidget.reading.windAvgMps, 5);
  assert.equal(holfuyWidget.reading.windGustMps, 7);

  const awc = parseAwcMetarList(awcMetarFixture);
  assert.equal(awc.length, 1);
  assert.equal(awc[0].station.uid, 'awc:UDYZ');
  assert.equal(awc[0].station.country, null);
  assert.ok(Math.abs(awc[0].reading.windAvgMps - 5.1444) < 0.01);
  assert.equal(awc[0].reading.conditions?.dewPointC, 7.0);
  assert.ok((awc[0].reading.conditions?.relativeHumidityPercent ?? 0) > 40);
});

test('Tier 1 free-flight & niche windtalker parsers (Winds.mobi, WindSpion, WindGuru, WeatherLink, realtime.txt) normalize to SI contracts', () => {
  const wmList = parseWindsMobiList(
    JSON.stringify([
      {
        _id: 'holfuy-1104',
        'pv-code': 'holfuy',
        'pv-id': '1104',
        'pv-name': 'holfuy.com',
        short: 'Point of the Mountain',
        alt: 1555,
        loc: { type: 'Point', coordinates: [-111.9032, 40.4535] },
        last: {
          _id: 1793037600,
          'w-dir': 185,
          'w-avg': 21.6,
          'w-max': 28.8,
          temp: 18.4,
          hum: 42,
          pres: { qnh: 1015.2 },
        },
      },
    ]),
  );
  assert.equal(wmList.length, 1);
  assert.equal(wmList[0].station.uid, 'windsmobi:holfuy-1104');
  assert.equal(wmList[0].reading?.windAvgMps, 6);
  assert.equal(wmList[0].reading?.windGustMps, 8);
  const unwrapped = unwrapAggregatorStation(wmList[0].station);
  assert.equal(unwrapped.uid, 'holfuy:1104');
  assert.deepEqual(unwrapped.aliases, ['windsmobi:holfuy-1104']);

  const wmHist = parseWindsMobiHistoric(
    JSON.stringify([
      { _id: 1793034000, 'w-dir': 180, 'w-avg': 18.0, 'w-max': 25.2, temp: 18.0 },
      { _id: 1793037600, 'w-dir': 185, 'w-avg': 21.6, 'w-max': 28.8, temp: 18.4 },
    ]),
  );
  assert.ok(wmHist);
  assert.equal(wmHist.points.length, 2);

  const wsList = parseWindSpionList(
    JSON.stringify([
      {
        id: 'ws-101',
        name: 'Woodside Launch',
        lat: 49.2611,
        lon: -121.8722,
        alt: 645,
        ts: 1793037600,
        wind: 18.0,
        gust: 25.2,
        dir: 240,
        temp: 14.0,
      },
    ]),
  );
  assert.equal(wsList.length, 1);
  assert.equal(wsList[0].station.country, null);
  assert.equal(wsList[0].reading?.windAvgMps, 5);

  const wg = parseWindGuruCurrent(
    JSON.stringify({
      unixtime: 1793037600,
      wind_avg: 10,
      wind_max: 15,
      wind_min: 6,
      wind_direction: 270,
      temperature: 17.5,
      rh: 55,
      slp: 1013.2,
    }),
  );
  assert.ok(Math.abs(wg.windAvgMps - 5.1444) < 0.01);
  assert.equal(wg.windDirectionDeg, 270);

  const wl = parseWeatherLinkBulletin(
    JSON.stringify({
      oMaiaData: [
        {
          timestamp: 1793037600,
          logicalSensor: [
            {
              productName: 'Temp/Hum',
              sensorDataType: [
                { sensorDataName: '10 Min Avg Wind Speed', dataValue: 10 },
                { sensorDataName: '10 Min High Wind Speed', dataValue: 15 },
                { sensorDataName: '10 Min Scalar Avg Wind Direction', dataValue: 210 },
                { sensorDataName: 'Temp', dataValue: 68 },
              ],
            },
          ],
        },
      ],
    }),
    1793037600000,
  );
  assert.ok(Math.abs(wl.windAvgMps - 4.4704) < 0.01);
  assert.equal(wl.temperatureC, 20);

  const rtLine =
    '26/10/26 18:00:00 18.5 52 8.4 18.0 21.6 265 0.0 0.0 1015.2 W 3 km/h C hPa mm 120.0 +0.1';
  const rt = parseRealtimeTxt(rtLine, 'UTC');
  assert.equal(rt.windAvgMps, 5);
  assert.equal(rt.windGustMps, null);
  assert.equal(rt.windDirectionDeg, 265);
  assert.equal(rt.temperatureC, 18.5);
});

test('Tier 2, 3, and 4 mountain, synoptic, marine, and citizen parsers normalize upstream formats', () => {
  // RAWS
  const raws = parseRawsFeatureCollection(
    JSON.stringify({
      features: [
        {
          attributes: {
            NWSID: 'TT029',
            StationName: 'Slide Mountain',
            State: 'NV',
            Elevation: 9650,
            ObservationTime: 1793037600000,
            WindSpeed: 10,
            WindGust: 18,
            WindDirection: 250,
            AirTemp: 50,
            RelativeHumidity: 35,
          },
          geometry: { x: -119.8847, y: 39.3133 },
        },
      ],
    }),
  );
  assert.equal(raws.length, 1);
  assert.equal(raws[0].station.uid, 'raws:TT029');
  assert.equal(raws[0].reading?.temperatureC, 10);

  // SNOTEL
  const snotelStations = parseSnotelStationsList(
    JSON.stringify([
      {
        stationTriplet: '828:UT:SNTL',
        name: 'Timpanogos Divide',
        stateCode: 'UT',
        latitude: 40.427,
        longitude: -111.617,
        elevation: 8140,
      },
    ]),
  );
  assert.equal(snotelStations.length, 1);
  assert.equal(snotelStations[0].uid, 'snotel:828:UT:SNTL');

  const snotelReading = parseSnotelDataResponse(
    JSON.stringify([
      {
        data: [
          {
            stationElement: { elementCode: 'WSPDV' },
            values: [{ date: '2026-10-26 18:00', value: 10 }],
          },
          {
            stationElement: { elementCode: 'WSPDX' },
            values: [{ date: '2026-10-26 18:00', value: 16 }],
          },
          {
            stationElement: { elementCode: 'WDIRV' },
            values: [{ date: '2026-10-26 18:00', value: 195 }],
          },
          {
            stationElement: { elementCode: 'TOBS' },
            values: [{ date: '2026-10-26 18:00', value: 41 }],
          },
        ],
      },
    ]),
    -8,
  );
  assert.ok(Math.abs(snotelReading.windAvgMps - 4.4704) < 0.01);
  assert.equal(snotelReading.temperatureC, 5);

  // Avalanche Canada
  const avyStations = parseAvalancheCanadaStations(
    JSON.stringify([
      {
        stationId: 'kicking-horse',
        name: 'Kicking Horse Summit',
        lat: 51.2975,
        lon: -117.0483,
        elevation: 2450,
      },
    ]),
  );
  assert.equal(avyStations.length, 1);
  const avyMeas = parseAvalancheCanadaMeasurements(
    JSON.stringify([
      {
        measurementDateTime: '2026-10-26T17:00:00Z',
        windSpeedAvg: 18,
        windSpeedGust: 28.8,
        windDirAvg: 240,
        airTempAvg: -3.5,
      },
      {
        measurementDateTime: '2026-10-26T18:00:00Z',
        windSpeedAvg: 21.6,
        windSpeedGust: 32.4,
        windDirAvg: 245,
        airTempAvg: -3.0,
      },
    ]),
  );
  assert.equal(avyMeas.reading.windAvgMps, 6);
  assert.equal(avyMeas.history?.points.length, 2);

  // IEM
  const iemStations = parseIemNetworkGeoJson(
    JSON.stringify({
      features: [
        {
          id: 'SEA',
          properties: {
            sname: 'Seattle Tacoma',
            state: 'WA',
            country: 'US',
            elevation: 132,
            tzname: 'America/Los_Angeles',
            network: 'WA_ASOS',
          },
          geometry: { coordinates: [-122.309, 47.449] },
        },
      ],
    }),
  );
  assert.equal(iemStations.length, 1);
  const iemCurrents = parseIemCurrentsResponse(
    JSON.stringify({
      data: [
        {
          station: 'SEA',
          utc_valid: '2026-10-26T18:00:00Z',
          sknt: 10,
          gust: 16,
          drct: 190,
          tmpf: 59,
          dwpf: 45,
          relh: 60,
          mslp: 1016.2,
        },
      ],
    }),
  );
  assert.equal(iemCurrents.get('SEA')?.temperatureC, 15);

  // NWS
  const nwsStations = parseNwsStationsCollection(
    JSON.stringify({
      features: [
        {
          properties: {
            stationIdentifier: 'KSEA',
            name: 'Seattle-Tacoma',
            timeZone: 'America/Los_Angeles',
            elevation: { value: 132, unitCode: 'wmoUnit:m' },
          },
          geometry: { coordinates: [-122.309, 47.449] },
        },
      ],
    }),
    'WA',
  );
  assert.equal(nwsStations.length, 1);
  const nwsObs = parseNwsLatestObservation(
    JSON.stringify({
      properties: {
        timestamp: '2026-10-26T18:00:00Z',
        windSpeed: { value: 18, unitCode: 'wmoUnit:km_h-1' },
        windGust: { value: 25.2, unitCode: 'wmoUnit:km_h-1' },
        windDirection: { value: 210, unitCode: 'wmoUnit:degree_(angle)' },
        temperature: { value: 14.2, unitCode: 'wmoUnit:degC' },
        seaLevelPressure: { value: 101520, unitCode: 'wmoUnit:Pa' },
      },
    }),
  );
  assert.equal(nwsObs.windAvgMps, 5);
  assert.equal(nwsObs.conditions?.seaLevelPressureHpa, 1015.2);

  // ECCC SWOB
  const ecccStations = parseEcccSwobStations(
    JSON.stringify({
      features: [
        {
          id: 'CWJT',
          properties: { iata_id: 'CWJT', name: 'Pemberton', elevation: 204 },
          geometry: { coordinates: [-122.7378, 50.3025] },
        },
      ],
    }),
  );
  assert.equal(ecccStations.length, 1);
  const ecccObs = parseEcccSwobRealtime(
    JSON.stringify({
      features: [
        {
          properties: {
            'date_tm-value': '2026-10-26T18:00:00Z',
            avg_wnd_spd_10m_pst10mts: 18.0,
            max_wnd_spd_10m_pst10mts: 25.2,
            avg_wnd_dir_10m_pst10mts: 200,
            air_temp: 12.5,
            mslp: 1014.0,
          },
        },
      ],
    }),
  );
  assert.equal(ecccObs.windAvgMps, 5);

  // NDBC
  const ndbcLatest = parseNdbcLatestObs(
    '#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE\n' +
      'FTPC1 37.806 -122.466 2026 10 26 18 00 280 7.2 9.5 MM MM MM MM 1016.2 +0.5 15.1 14.2 11.0 MM MM\n',
  );
  assert.equal(ndbcLatest.length, 1);
  assert.equal(ndbcLatest[0].reading.windAvgMps, 7.2);

  const ndbcHist = parseNdbcRealtime2(
    '#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE\n' +
      '2026 10 26 18 00 280 7.2 9.5 MM MM MM MM 1016.2 15.1 14.2 11.0 MM +0.5 MM\n' +
      '2026 10 26 17 50 275 6.8 8.9 MM MM MM MM 1016.0 15.0 14.2 11.0 MM +0.4 MM\n',
  );
  assert.equal(ndbcHist.reading.windAvgMps, 7.2);
  assert.equal(ndbcHist.history?.points.length, 2);

  // CONAGUA
  const conaguaList = parseConaguaEmasCatalogue(
    JSON.stringify([
      { id_estacion: '318', nombre: 'COLIMA', latitud: '19.2333', longitud: '-103.7333' },
    ]),
  );
  assert.equal(conaguaList.length, 1);
  const conaguaObs = parseConaguaEmaObservation(
    JSON.stringify({ vel_viento: 18.0, raf_viento: 25.2, dir_viento: 215, temperatura: 24.5, fecha: '2026-10-26T18:00:00Z' }),
    1793037600000,
  );
  assert.equal(conaguaObs.windAvgMps, 5);

  // CWOP APRS, Windy, WU, Synoptic, Ambient
  const cwop = parseAprsWxPacket(
    'EW4821>APRS,TCPXX*:@261800z3944.08N/10514.53W_270/010g015t050r000p000P000h45b10152',
    1793037600000,
  );
  assert.ok(Math.abs(cwop.windAvgMps - 4.4704) < 0.01);
  assert.equal(cwop.temperatureC, 10);
  assert.equal(cwop.conditions?.seaLevelPressureHpa, 1015.2);

  const windy = parseWindyPwsResponse(
    JSON.stringify({
      data: {
        ts: [1793034000000, 1793037600000],
        wind: [5.2, 6.4],
        gust: [7.8, 9.1],
        windDir: [200, 210],
        temp: [288.15, 289.15],
      },
    }),
  );
  assert.equal(windy.reading.windAvgMps, 6.4);
  assert.equal(windy.reading.temperatureC, 16);
  assert.equal(windy.history?.points.length, 2);

  const wu = parseWuPwsCurrent(
    JSON.stringify({
      observations: [
        {
          obsTimeUtc: '2026-10-26T18:00:00Z',
          winddir: 225,
          humidity: 50,
          metric: { windSpeed: 18, windGust: 25.2, temp: 17.0, dewpt: 6.5, pressure: 1014.8 },
        },
      ],
    }),
  );
  assert.equal(wu.windAvgMps, 5);

  const synoptic = parseSynopticLatest(
    JSON.stringify({
      STATION: [
        {
          OBSERVATIONS: {
            wind_speed_value_1: { value: 6.1, date_time: '2026-10-26T18:00:00Z' },
            wind_gust_value_1: { value: 9.2 },
            wind_direction_value_1: { value: 250 },
            air_temp_value_1: { value: 12.3 },
          },
        },
      ],
    }),
  );
  assert.equal(synoptic.windAvgMps, 6.1);

  const ambient = parseAmbientDeviceObservation(
    JSON.stringify([
      {
        dateutc: 1793037600000,
        windspeedmph: 10,
        windgustmph: 15,
        winddir: 180,
        tempf: 68,
        humidity: 40,
        baromrelin: 29.92,
      },
    ]),
  );
  assert.equal(ambient.temperatureC, 20);
});

test('discoverStations aggregates US, CA, MX, and AM stations and filters out out-of-scope regions', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: createProviderFetch({
      minIntervalMs: 0,
      baseDelayMs: 0,
      fetch: async input => {
        const url = String(input);
        if (url.includes('pioupiou.fr')) {
          return new Response(openWindMapFixture, { status: 200 });
        }
        return new Response('offline', { status: 404 });
      },
    }),
  };

  const catalogue = await discoverStations({
    regions: ['US', 'CA', 'MX', 'AM'],
    seeds: INITIAL_SEED_STATIONS,
    includeRemoteDiscovery: true,
    environment,
  });

  const countries = new Set(catalogue.stations.map(s => s.country));
  assert.deepEqual([...countries].sort(), ['AM', 'CA', 'MX', 'US']);
  assert.equal(
    catalogue.stations.some(s => s.uid === 'openwindmap:999'),
    false,
    'Chamonix (FR) must be filtered out of US/CA/MX/AM scope',
  );
  assert.equal(
    catalogue.stations.some(s => s.uid === 'openwindmap:618'),
    true,
    'Valle de Bravo (MX) must be retained',
  );
});

test('defineStationAdapter wrappers load OpenWindMap, Holfuy, and AWC stations and degrade cleanly on error', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('pioupiou.fr/v1/live-with-meta/618')) {
        return new Response(JSON.stringify({ data: JSON.parse(openWindMapFixture).data[0] }), {
          status: 200,
        });
      }
      if (url.includes('api.holfuy.com')) {
        return new Response(holfuyFixture, { status: 200 });
      }
      if (url.includes('aviationweather.gov')) {
        return new Response(awcMetarFixture, { status: 200 });
      }
      return new Response('upstream error', { status: 502 });
    },
  };

  const owmStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'openwindmap:618');
  const holfuyStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'holfuy:1652');
  const awcStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'awc:UDYZ');
  assert.ok(owmStation && holfuyStation && awcStation);

  const loadedOwm = await loadOpenWindMapStation({ station: owmStation }, { environment });
  assert.equal(loadedOwm.status, 'ok');
  assert.equal(loadedOwm.reading.windAvgMps, 5);

  const loadedHolfuy = await loadHolfuyStation({ station: holfuyStation }, { environment });
  assert.equal(loadedHolfuy.status, 'ok');
  assert.equal(loadedHolfuy.reading.windAvgMps, 6.4);

  const loadedAwc = await loadAwcStation({ station: awcStation }, { environment });
  assert.equal(loadedAwc.status, 'ok');
  assert.equal(loadedAwc.reading.temperatureC, 19.0);
});

test('createStationsApiHandler serves spatial /catalogue slices and live /feed in both Azohra JSON and GeoJSON formats', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('api.holfuy.com')) {
        return new Response(holfuyFixture, { status: 200 });
      }
      if (url.includes('aviationweather.gov')) {
        return new Response(awcMetarFixture, { status: 200 });
      }
      return new Response('not mocked', { status: 502 });
    },
  };

  const catalogue = await discoverStations({
    seeds: INITIAL_SEED_STATIONS,
    includeRemoteDiscovery: false,
    environment,
  });

  const handler = createStationsApiHandler({
    catalogue,
    credentials: { holfuyApiKey: 'test-holfuy-key' },
    environment,
    basePath: '/api/stations',
  });

  // 1. Spatial query for Armenia stations
  const catRes = await handler(
    new Request('https://stations.example/api/stations/catalogue?country=AM'),
  );
  assert.equal(catRes.status, 200);
  const catJson = await catRes.json();
  assert.ok(catJson.stations.length >= 4);
  assert.ok(catJson.stations.every(s => s.country === 'AM'));

  // 2. Category filter query
  const mountainRes = await handler(
    new Request('https://stations.example/api/stations/catalogue?category=mountain'),
  );
  assert.equal(mountainRes.status, 200);
  const mountainJson = await mountainRes.json();
  assert.ok(mountainJson.stations.length >= 3);
  assert.ok(mountainJson.stations.every(s => s.category === 'mountain'));

  // 2b. Place filter (physical siting) and invalid token rejection
  const airportRes = await handler(
    new Request('https://stations.example/api/stations/catalogue?place=airport'),
  );
  assert.equal(airportRes.status, 200);
  const airportJson = await airportRes.json();
  assert.ok(airportJson.stations.length >= 1);
  assert.ok(airportJson.stations.every(s => s.place === 'airport'));
  const badPlaceRes = await handler(
    new Request('https://stations.example/api/stations/catalogue?place=valley'),
  );
  assert.equal(badPlaceRes.status, 400);

  // 3. Live Azohra StationFeed for selected Armenia stations
  const feedRes = await handler(
    new Request('https://stations.example/api/stations/feed?ids=holfuy:1652,awc:UDYZ'),
  );
  assert.equal(feedRes.status, 200);
  const feedJson = await feedRes.json();
  assert.equal(feedJson.stations.length, 2);
  assert.equal(feedJson.stations[0].status, 'ok');
  assert.equal(feedJson.stations[1].status, 'ok');

  // 4. Live GeoJSON feed for custom maps / Windy plugin
  const geoRes = await handler(
    new Request(
      'https://stations.example/api/stations/feed?ids=holfuy:1652,awc:UDYZ&format=geojson',
    ),
  );
  assert.equal(geoRes.status, 200);
  const geoJson = await geoRes.json();
  assert.equal(geoJson.type, 'FeatureCollection');
  assert.equal(geoJson.features.length, 2);
  assert.equal(geoJson.features[0].properties.status, 'ok');
  assert.equal(geoJson.features[0].properties.country, 'AM');
});
