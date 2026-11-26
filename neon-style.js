// TripTrack "Neon Night" map style for MapLibre GL, on the free OpenFreeMap vector tiles
// (OpenMapTiles schema, no account or key). Shared by the app (assets/neon-style.js) and the
// web page (web/neon-style.js): keep the two copies identical.
(function () {
  var C = {
    ground: '#071330', green: '#08213A', water: '#030A1C', waterLine: '#0C2A5C',
    minor: '#1E7FE0', mid: '#2AA8F5', major: '#33D1FF', motorway: '#8FE6FF',
    building: '#0A1838', buildingTop: '#0F2452', label: '#CFEFFF', place: '#EAF4FF', rail: '#21407E',
  };
  var Z = function (stops) { return ['interpolate', ['exponential', 1.5], ['zoom']].concat(stops); };
  var road = function (classes) { return ['all', ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']]; };

  window.neonStyle = function () {
    return {
      version: 8,
      name: 'TripTrack Neon Night',
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        omt: {
          type: 'vector',
          url: 'https://tiles.openfreemap.org/planet',
          attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': C.ground } },
        { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover',
          filter: ['match', ['get', 'class'], ['grass', 'wood', 'farmland'], true, false], paint: { 'fill-color': C.green, 'fill-opacity': 0.7 } },
        { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.green, 'fill-opacity': 0.8 } },
        { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': C.water } },
        { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': C.waterLine, 'line-width': Z([10, 0.5, 16, 3]) } },
        { id: 'buildings-flat', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, maxzoom: 15,
          paint: { 'fill-color': C.building, 'fill-opacity': 0.7 } },
        { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'],
          paint: { 'line-color': C.rail, 'line-width': Z([10, 0.6, 16, 2]), 'line-dasharray': [3, 3] } },
        // streets: fine minor grid, brighter towards the big roads
        { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road(['minor', 'service', 'track']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': C.minor, 'line-opacity': 0.85, 'line-width': Z([12, 0.4, 15, 1.2, 18, 4]) } },
        { id: 'road-mid', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road(['tertiary', 'secondary']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': C.mid, 'line-width': Z([9, 0.6, 14, 1.8, 18, 7]) } },
        { id: 'road-major-glow', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road(['primary', 'trunk', 'motorway']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': C.major, 'line-opacity': 0.4, 'line-blur': 4, 'line-width': Z([6, 2, 12, 6, 18, 24]) } },
        { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road(['primary', 'trunk']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': C.major, 'line-width': Z([7, 0.8, 12, 2, 18, 9]) } },
        { id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: road(['motorway']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': C.motorway, 'line-width': Z([5, 0.8, 12, 2.4, 18, 11]) } },
        // 3D buildings: flat from above, rising when the map is tilted (live trip)
        { id: 'buildings-3d', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 15,
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, C.building, 30, C.buildingTop],
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.92,
          } },
        { id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
          filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk', 'minor'], true, false],
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-letter-spacing': 0.04 },
          paint: { 'text-color': C.label, 'text-halo-color': C.ground, 'text-halo-width': 1.6 } },
        { id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place',
          filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb'], true, false],
          layout: {
            'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'],
            'text-size': ['match', ['get', 'class'], 'city', 15, 'town', 13, 11],
          },
          paint: { 'text-color': C.place, 'text-halo-color': C.ground, 'text-halo-width': 1.8 } },
      ],
    };
  };

  /** Route and heatmap colours; the app's legends use the same (MapColors in Theme.kt, checked by MapColorsTest). */
  window.NEON = {
    speedSlow: 80, speedFast: 110,
    speed: ['#33D1FF', '#FFC83D', '#FF9A1F'],
    heat: ['#B5761E', '#FF9A1F', '#FFC83D', '#FFE38A', '#FFFFFF'],
  };

  /** Speed colours of a driven route: cyan, yellow, orange. */
  window.neonSpeedColor = function (kmh) {
    if (kmh < NEON.speedSlow) return NEON.speed[0];
    if (kmh <= NEON.speedFast) return NEON.speed[1];
    return NEON.speed[2];
  };
})();
