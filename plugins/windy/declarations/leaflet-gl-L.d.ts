/** Leaflet calls the station overlay makes on the Windy map. */
declare namespace L {
  interface LeafletPoint {
    x: number;
    y: number;
  }

  interface LeafletLatLng {
    lat: number;
    lng: number;
  }

  interface LeafletBounds {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  }

  interface LeafletEvented {
    on(type: string, fn: () => void): this;
    off(type: string, fn: () => void): this;
  }

  interface LeafletGlMap extends LeafletEvented {
    getSize(): LeafletPoint;
    getCenter(): LeafletLatLng;
    getZoom(): number;
    getBounds(): LeafletBounds;
    latLngToContainerPoint(latlng: [number, number]): LeafletPoint;
  }

  interface Marker extends LeafletEvented {
    addTo(map: LeafletGlMap): this;
    remove(): this;
    getElement(): HTMLElement | undefined;
    setLatLng(latlng: [number, number]): this;
    setZIndexOffset(offset: number): this;
  }

  interface Popup extends LeafletEvented {
    setContent(content: HTMLElement): this;
    setLatLng(latlng: [number, number]): this;
    openOn(map: LeafletGlMap): this;
    remove(): this;
  }

  interface DivIconOptions {
    className?: string;
    html?: string;
    iconSize?: [number, number];
    iconAnchor?: [number, number];
  }

  interface MarkerOptions {
    icon?: unknown;
    keyboard?: boolean;
    bubblingMouseEvents?: boolean;
  }

  interface PopupOptions {
    className?: string;
    autoPan?: boolean;
    keepInView?: boolean;
    closeButton?: boolean;
    closeOnEscapeKey?: boolean;
    closeOnClick?: boolean;
    maxWidth?: number;
  }

  class Marker {
    constructor(latlng: [number, number], options?: MarkerOptions);
    addTo(map: LeafletGlMap): this;
    remove(): this;
    getElement(): HTMLElement | undefined;
    setLatLng(latlng: [number, number]): this;
    setZIndexOffset(offset: number): this;
  }

  function divIcon(options?: DivIconOptions): unknown;
  function popup(options?: PopupOptions): Popup;
}
