import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
  name: 'windy-plugin-stations-observations',
  version: '0.1.0',
  icon: 'S',
  title: 'Station observations',
  description: 'Live wind observations from weather stations.',
  author: 'Stations',
  desktopUI: 'rhpane',
  mobileUI: 'small',
  routerPath: '/stations-observations',
  private: true,
};

export default config;
