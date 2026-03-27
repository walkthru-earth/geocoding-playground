<script lang="ts">
  import { untrack } from 'svelte'
  import maplibregl from 'maplibre-gl'

  const STYLE_LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
  const STYLE_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

  /** Read a CSS custom property to get the resolved color string */
  function getMarkerColor(type: 'primary' | 'secondary'): string {
    const prop = type === 'primary' ? '--wt-marker-primary' : '--wt-marker-secondary'
    return getComputedStyle(document.documentElement).getPropertyValue(prop).trim() || (type === 'primary' ? '#36d399' : '#f0a030')
  }

  /** Detect if we should use dark map tiles */
  function isDarkMode(): boolean {
    const theme = document.documentElement.getAttribute('data-theme')
    if (theme === 'walkthru-light') return false
    if (theme === 'walkthru-dark') return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  interface Props {
    center?: [number, number]
    zoom?: number
    class?: string
    onMapReady?: (map: maplibregl.Map) => void
  }

  let { center = [0, 20], zoom = 1.5, class: className = '', onMapReady }: Props = $props()

  let container: HTMLDivElement
  let map: maplibregl.Map | null = null

  // Track custom layers so they can be restored after a style swap
  interface StoredLayer {
    id: string
    geojson: GeoJSON.GeoJSON
    fillColor: string | maplibregl.DataDrivenPropertyValueSpecification<string>
    fillOpacity: number
    lineColor: string
    lineWidth: number
    visible: boolean
    popupFn?: (props: Record<string, any>) => string
  }
  const customLayers = new Map<string, StoredLayer>()
  const layerClickHandlers = new Set<string>()
  let currentDark = false

  /** Re-add all tracked custom layers to the map */
  function restoreCustomLayers() {
    if (!map) return
    for (const [id, layer] of customLayers) {
      const vis = layer.visible ? 'visible' : 'none'
      if (!map.getSource(id)) {
        map.addSource(id, { type: 'geojson', data: layer.geojson as any })
      }
      if (!map.getLayer(`${id}-fill`)) {
        map.addLayer({
          id: `${id}-fill`,
          type: 'fill',
          source: id,
          paint: { 'fill-color': layer.fillColor as any, 'fill-opacity': layer.fillOpacity },
          layout: { visibility: vis },
        })
      }
      if (!map.getLayer(`${id}-line`)) {
        map.addLayer({
          id: `${id}-line`,
          type: 'line',
          source: id,
          paint: { 'line-color': layer.lineColor, 'line-width': layer.lineWidth, 'line-opacity': 0.7 },
          layout: { visibility: vis },
        })
      }
      // Re-register click handlers (they are lost on style swap)
      if (layer.popupFn) {
        registerClickHandler(id, layer.popupFn)
      }
    }
  }

  function registerClickHandler(id: string, popupFn: (props: Record<string, any>) => string) {
    if (!map || layerClickHandlers.has(id)) return
    layerClickHandlers.add(id)
    map.on('click', `${id}-fill`, (e) => {
      if (!e.features?.[0]) return
      const props = e.features[0].properties ?? {}
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(popupFn(props))
        .addTo(map!)
    })
    map.on('mouseenter', `${id}-fill`, () => { map!.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', `${id}-fill`, () => { map!.getCanvas().style.cursor = '' })
  }

  $effect(() => {
    if (!container) return

    const initialCenter = untrack(() => center)
    const initialZoom = untrack(() => zoom)
    const readyCb = untrack(() => onMapReady)

    currentDark = isDarkMode()

    map = new maplibregl.Map({
      container,
      style: currentDark ? STYLE_DARK : STYLE_LIGHT,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

    map.on('load', () => {
      readyCb?.(map!)
    })

    // Auto-resize when container dimensions change (e.g. split pane drag)
    const ro = new ResizeObserver(() => { map?.resize() })
    ro.observe(container)

    // Switch basemap when theme changes
    function updateBasemap() {
      if (!map) return
      const dark = isDarkMode()
      if (dark === currentDark) return
      currentDark = dark

      // Clear handler tracking so they get re-registered after style load
      layerClickHandlers.clear()

      map.setStyle(dark ? STYLE_DARK : STYLE_LIGHT)
    }

    // Restore custom layers after vector style finishes loading
    map.on('style.load', () => {
      restoreCustomLayers()
    })

    // Watch for data-theme attribute changes on <html>
    const observer = new MutationObserver(updateBasemap)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // Watch for system preference changes (when theme is "system")
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', updateBasemap)

    return () => {
      mq.removeEventListener('change', updateBasemap)
      observer.disconnect()
      ro.disconnect()
      map?.remove()
      map = null
    }
  })

  /** Fly to a point and place/update a marker */
  let marker: maplibregl.Marker | null = null

  export function flyTo(lng: number, lat: number, z: number = 16) {
    if (!map) return
    map.flyTo({ center: [lng, lat], zoom: z, duration: 1500 })
    if (marker) marker.remove()
    marker = new maplibregl.Marker({ color: getMarkerColor('primary') })
      .setLngLat([lng, lat])
      .addTo(map)
  }

  /** Fit map to a bounding box [west, south, east, north] */
  export function fitBounds(bounds: [number, number, number, number], padding = 40) {
    if (!map) return
    map.fitBounds(bounds, { padding, duration: 1000 })
  }

  /** Add a GeoJSON source + layer (simple, no popup) */
  export function setGeoJSON(id: string, geojson: GeoJSON.GeoJSON, paint: Record<string, any> = {}) {
    if (!map) return
    if (map.getSource(id)) {
      (map.getSource(id) as maplibregl.GeoJSONSource).setData(geojson as any)
    } else {
      map.addSource(id, { type: 'geojson', data: geojson as any })
      map.addLayer({
        id: `${id}-fill`,
        type: 'fill',
        source: id,
        paint: { 'fill-color': getMarkerColor('primary'), 'fill-opacity': 0.15, ...paint },
      })
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        paint: { 'line-color': getMarkerColor('primary'), 'line-width': 1.5, 'line-opacity': 0.6 },
      })
    }
    // Track for restoration
    customLayers.set(id, {
      id,
      geojson,
      fillColor: paint['fill-color'] ?? getMarkerColor('primary'),
      fillOpacity: paint['fill-opacity'] ?? 0.15,
      lineColor: getMarkerColor('primary'),
      lineWidth: 1.5,
      visible: true,
    })
  }

  /** Remove marker */
  export function clearMarker() {
    if (marker) { marker.remove(); marker = null }
  }

  /** Result marker point with rich popup data */
  export interface MapResultPoint {
    lng: number
    lat: number
    popupHtml?: string
    label?: string
  }

  /** Add native MapLibre markers with rich HTML popups */
  let resultMarkers: maplibregl.Marker[] = []

  export function setResultMarkers(points: MapResultPoint[], autoFit = true) {
    resultMarkers.forEach(m => m.remove())
    resultMarkers = []
    if (!map || points.length === 0) return

    points.forEach((p, i) => {
      const isFirst = i === 0

      const popup = new maplibregl.Popup({
        offset: 25,
        maxWidth: '340px',
        closeButton: true,
      })

      if (p.popupHtml) {
        popup.setHTML(p.popupHtml)
      } else if (p.label) {
        popup.setText(p.label)
      }

      const m = new maplibregl.Marker({
        color: isFirst ? getMarkerColor('primary') : getMarkerColor('secondary'),
        scale: isFirst ? 1.0 : 0.8,
      })
        .setLngLat([p.lng, p.lat])
        .setPopup(popup)
        .addTo(map!)

      // Block click from reaching map canvas (prevents reverse geocode re-trigger)
      m.getElement().classList.add('result-marker')

      resultMarkers.push(m)
    })

    // Auto-open the first marker's popup
    if (resultMarkers.length > 0) {
      resultMarkers[0].togglePopup()
    }

    if (!autoFit) return

    // Compute bounds and fly to results
    const bounds = new maplibregl.LngLatBounds()
    points.forEach(p => bounds.extend([p.lng, p.lat]))

    // Check if all points are very close together (degenerate bounds)
    const ne = bounds.getNorthEast()
    const sw = bounds.getSouthWest()
    const spanLng = Math.abs(ne.lng - sw.lng)
    const spanLat = Math.abs(ne.lat - sw.lat)

    if (points.length === 1 || (spanLng < 0.002 && spanLat < 0.002)) {
      const center = bounds.getCenter()
      map.flyTo({ center, zoom: 18, duration: 1500 })
    } else {
      map.fitBounds(bounds, { padding: 60, maxZoom: 18, duration: 1500 })
    }
  }

  /** Open a specific result marker's popup by index (0-based) */
  export function openResultPopup(index: number) {
    if (!map) return
    // Close all open popups
    resultMarkers.forEach(m => {
      if (m.getPopup()?.isOpen()) m.togglePopup()
    })
    if (index >= 0 && index < resultMarkers.length) {
      const m = resultMarkers[index]
      m.togglePopup()
      map.flyTo({ center: m.getLngLat(), zoom: Math.max(map.getZoom(), 18), duration: 800 })
    }
  }

  export function clearResultMarkers() {
    resultMarkers.forEach(m => m.remove())
    resultMarkers = []
  }

  /** Add a styled GeoJSON layer with popup on click */
  export function addGeoJSONLayer(
    id: string,
    geojson: GeoJSON.GeoJSON,
    options: {
      fillColor?: string | maplibregl.DataDrivenPropertyValueSpecification<string>
      fillOpacity?: number
      lineColor?: string
      lineWidth?: number
      popupFn?: (props: Record<string, any>) => string
      visible?: boolean
    } = {}
  ) {
    if (!map) return
    const { fillColor = getMarkerColor('primary'), fillOpacity = 0.2, lineColor = getMarkerColor('primary'), lineWidth = 1, popupFn, visible = true } = options
    const vis = visible ? 'visible' : 'none'

    if (map.getSource(id)) {
      (map.getSource(id) as maplibregl.GeoJSONSource).setData(geojson as any)
    } else {
      map.addSource(id, { type: 'geojson', data: geojson as any })
      map.addLayer({
        id: `${id}-fill`,
        type: 'fill',
        source: id,
        paint: { 'fill-color': fillColor as any, 'fill-opacity': fillOpacity },
        layout: { visibility: vis },
      })
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        paint: { 'line-color': lineColor, 'line-width': lineWidth, 'line-opacity': 0.7 },
        layout: { visibility: vis },
      })
    }

    // Track for restoration after style swap
    customLayers.set(id, { id, geojson, fillColor, fillOpacity, lineColor, lineWidth, visible, popupFn })

    if (popupFn) {
      registerClickHandler(id, popupFn)
    }
  }

  /** Toggle layer visibility */
  export function setLayerVisibility(id: string, visible: boolean) {
    if (!map) return
    const vis = visible ? 'visible' : 'none'
    if (map.getLayer(`${id}-fill`)) map.setLayoutProperty(`${id}-fill`, 'visibility', vis)
    if (map.getLayer(`${id}-line`)) map.setLayoutProperty(`${id}-line`, 'visibility', vis)
    // Keep tracked state in sync
    const stored = customLayers.get(id)
    if (stored) stored.visible = visible
  }

  export function getMap(): maplibregl.Map | null {
    return map
  }
</script>

<div bind:this={container} class="w-full overflow-hidden {className}"></div>
